import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, type Database, type Transaction } from "@/server/db";
import { parseQuantity, toDbQuantity, type Milli } from "@/shared/quantity";
import { godowns, stockLevels, stockMovements, STOCK_MOVEMENT_KINDS } from "./schema";

/**
 * The stock journal. stock_movements is the source of truth (append-only, enforced by triggers and
 * privileges); stock_levels is a cache, one row per product and godown, that is only ever written here,
 * in the same transaction as the movement it reflects.
 */

export type LedgerTotal = { qty: Milli; movements: number; lastMovementId: number };
export type CacheRow = { qty: Milli; lastMovementId: number };

export function signedQuantity(value: string): Milli {
  return value.startsWith("-") ? -parseQuantity(value.slice(1)) : parseQuantity(value);
}

/**
 * SUM(qty_base) per product straight from the journal (the v_stock definition, scoped to the shop). Shop-wide unless a godown
 * is given, in which case it is that godown's own stock.
 */
export async function ledgerTotals(shopId: string, productIds: string[], db: Database | Transaction = getDb(), options: { godownId?: string } = {}): Promise<Map<string, LedgerTotal>> {
  if (productIds.length === 0) return new Map();
  const rows = await db
    .select({
      productId: stockMovements.productId,
      qty: sql<string>`sum(${stockMovements.qtyBase})::text`,
      movements: sql<number>`count(*)::int`,
      lastMovementId: sql<number>`max(${stockMovements.id})::bigint`,
    })
    .from(stockMovements)
    .where(and(eq(stockMovements.shopId, shopId), inArray(stockMovements.productId, productIds), options.godownId ? eq(stockMovements.godownId, options.godownId) : undefined))
    .groupBy(stockMovements.productId);
  return new Map(rows.map((row) => [row.productId, { qty: signedQuantity(row.qty), movements: row.movements, lastMovementId: Number(row.lastMovementId) }]));
}

/** The cache per product: summed over the godowns, or one godown's row. */
export async function cacheRows(shopId: string, productIds: string[], db: Database | Transaction = getDb(), options: { godownId?: string } = {}): Promise<Map<string, CacheRow>> {
  if (productIds.length === 0) return new Map();
  const rows = await db
    .select({ productId: stockLevels.productId, qty: sql<string>`sum(${stockLevels.qtyBase})::text`, lastMovementId: sql<number>`max(${stockLevels.lastMovementId})::bigint` })
    .from(stockLevels)
    .where(and(eq(stockLevels.shopId, shopId), inArray(stockLevels.productId, productIds), options.godownId ? eq(stockLevels.godownId, options.godownId) : undefined))
    .groupBy(stockLevels.productId);
  return new Map(rows.map((row) => [row.productId, { qty: signedQuantity(row.qty), lastMovementId: Number(row.lastMovementId) }]));
}

/**
 * Where a document's stock actually went: product -> godown, from the movements it posted (the first of each product). Cancellations and
 * returns put stock back where it came from by reading this, never by guessing or by picking the godown that happens to have stock.
 */
export async function originalGodowns(db: Database | Transaction, shopId: string, sourceType: string, sourceId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ productId: stockMovements.productId, godownId: stockMovements.godownId })
    .from(stockMovements)
    .where(and(eq(stockMovements.shopId, shopId), eq(stockMovements.sourceType, sourceType), eq(stockMovements.sourceId, sourceId)))
    .orderBy(stockMovements.id);
  const found = new Map<string, string>();
  for (const row of rows) if (!found.has(row.productId)) found.set(row.productId, row.godownId);
  return found;
}

/**
 * Products where any godown's cache row disagrees with that godown's own journal (quantity or last movement). The shop-wide
 * totals can agree while two godowns are wrong in opposite ways, so this looks at each (product, godown) pair.
 */
export async function godownMismatches(shopId: string, productIds: string[], db: Database | Transaction = getDb()): Promise<Set<string>> {
  if (productIds.length === 0) return new Set();
  const list = sql.join(productIds.map((id) => sql`${id}`), sql`, `);
  const result = await db.execute<{ product_id: string }>(sql`
    select distinct coalesce(m.product_id, c.product_id) as product_id
    from (select product_id, godown_id, sum(qty_base) as qty, max(id) as last from stock_movements where shop_id = ${shopId} and product_id in (${list}) group by product_id, godown_id) m
    full join (select product_id, godown_id, qty_base as qty, last_movement_id as last from stock_levels where shop_id = ${shopId} and product_id in (${list})) c
      on c.product_id = m.product_id and c.godown_id = m.godown_id
    where coalesce(m.qty, 0) <> coalesce(c.qty, 0) or (m.last is not null and c.last is not null and m.last <> c.last)`);
  return new Set(result.rows.map((row) => row.product_id));
}

/**
 * Locks the cache rows of these products (FOR UPDATE) for the rest of the transaction, always in (product_id, godown_id) order so
 * two transactions can never wait on each other. With no godowns given, every godown's row of each product is locked.
 */
export async function lockCacheRows(tx: Transaction, shopId: string, productIds: string[], godownIds?: string[]): Promise<void> {
  const ids = [...new Set(productIds)].sort();
  if (ids.length === 0) return;
  const places = godownIds ? [...new Set(godownIds)] : null;
  await tx
    .select({ productId: stockLevels.productId })
    .from(stockLevels)
    .where(and(eq(stockLevels.shopId, shopId), inArray(stockLevels.productId, ids), places && places.length > 0 ? inArray(stockLevels.godownId, places) : undefined))
    .orderBy(stockLevels.productId, stockLevels.godownId)
    .for("update");
}

export type NewMovement = {
  shopId: string;
  productId: string;
  /** Where the stock is. Leave out for the shop's default Main Store (single-godown shops never name one). */
  godownId?: string;
  movementDate: string;
  kind: (typeof STOCK_MOVEMENT_KINDS)[number];
  qtyBase: Milli;
  unitCostPaise: number | null;
  sourceType: string;
  sourceId: string;
  reason: string | null;
  /** The quantity, unit and factor as entered, for movements whose own document does not keep them. */
  entered?: { qty: string; unit: string; factor: string };
  createdBy: string;
};

/** The shop's default godown (Main Store). The migration creates it for every shop; setup creates it for new ones. */
export async function defaultGodownId(db: Database | Transaction, shopId: string): Promise<string> {
  const [row] = await db.select({ id: godowns.id }).from(godowns).where(and(eq(godowns.shopId, shopId), eq(godowns.isDefault, true))).limit(1);
  if (row) return row.id;
  const [created] = await db.insert(godowns).values({ shopId, name: "Main Store", isDefault: true }).onConflictDoNothing().returning({ id: godowns.id });
  if (created) return created.id;
  const [again] = await db.select({ id: godowns.id }).from(godowns).where(and(eq(godowns.shopId, shopId), eq(godowns.isDefault, true))).limit(1);
  return again!.id;
}

/** Appends one movement and moves the cache by the same amount, in the caller's transaction. */
export async function appendMovement(tx: Transaction, movement: NewMovement): Promise<number> {
  const godownId = movement.godownId ?? (await defaultGodownId(tx, movement.shopId));
  const { entered, godownId: requested, ...rest } = movement;
  void requested;
  const [row] = await tx
    .insert(stockMovements)
    .values({ ...rest, godownId, qtyBase: toDbQuantity(movement.qtyBase), enteredQty: entered?.qty ?? null, enteredUnit: entered?.unit ?? null, enteredFactor: entered?.factor ?? null })
    .returning({ id: stockMovements.id });
  await tx
    .insert(stockLevels)
    .values({ productId: movement.productId, godownId, shopId: movement.shopId, qtyBase: toDbQuantity(movement.qtyBase), lastMovementId: row!.id })
    .onConflictDoUpdate({
      target: [stockLevels.productId, stockLevels.godownId],
      set: { qtyBase: sql`${stockLevels.qtyBase} + excluded.qty_base`, lastMovementId: sql`excluded.last_movement_id`, updatedAt: sql`now()` },
    });
  return row!.id;
}
