import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, type Database, type Transaction } from "@/server/db";
import { parseQuantity, toDbQuantity, type Milli } from "@/shared/quantity";
import { stockLevels, stockMovements, STOCK_MOVEMENT_KINDS } from "./schema";

/**
 * The stock journal. stock_movements is the source of truth (append-only, enforced by triggers and
 * privileges); stock_levels is a cache that is only ever written here, in the same transaction as
 * the movement it reflects.
 */

export type LedgerTotal = { qty: Milli; movements: number; lastMovementId: number };
export type CacheRow = { qty: Milli; lastMovementId: number };

/** SUM(qty_base) per product straight from the journal (the v_stock definition, scoped to the shop). */
export async function ledgerTotals(shopId: string, productIds: string[], db: Database | Transaction = getDb()): Promise<Map<string, LedgerTotal>> {
  if (productIds.length === 0) return new Map();
  const rows = await db
    .select({
      productId: stockMovements.productId,
      qty: sql<string>`sum(${stockMovements.qtyBase})::text`,
      movements: sql<number>`count(*)::int`,
      lastMovementId: sql<number>`max(${stockMovements.id})::bigint`,
    })
    .from(stockMovements)
    .where(and(eq(stockMovements.shopId, shopId), inArray(stockMovements.productId, productIds)))
    .groupBy(stockMovements.productId);
  return new Map(rows.map((row) => [row.productId, { qty: signedQuantity(row.qty), movements: row.movements, lastMovementId: Number(row.lastMovementId) }]));
}

export async function cacheRows(shopId: string, productIds: string[], db: Database | Transaction = getDb()): Promise<Map<string, CacheRow>> {
  if (productIds.length === 0) return new Map();
  const rows = await db
    .select({ productId: stockLevels.productId, qty: stockLevels.qtyBase, lastMovementId: stockLevels.lastMovementId })
    .from(stockLevels)
    .where(and(eq(stockLevels.shopId, shopId), inArray(stockLevels.productId, productIds)));
  return new Map(rows.map((row) => [row.productId, { qty: signedQuantity(row.qty), lastMovementId: row.lastMovementId }]));
}

export function signedQuantity(value: string): Milli {
  return value.startsWith("-") ? -parseQuantity(value.slice(1)) : parseQuantity(value);
}

/** Locks the cache rows of these products (FOR UPDATE, product-id order) for the rest of the transaction. */
export async function lockCacheRows(tx: Transaction, shopId: string, productIds: string[]): Promise<void> {
  const ids = [...new Set(productIds)].sort();
  if (ids.length === 0) return;
  await tx
    .select({ productId: stockLevels.productId })
    .from(stockLevels)
    .where(and(eq(stockLevels.shopId, shopId), inArray(stockLevels.productId, ids)))
    .orderBy(stockLevels.productId)
    .for("update");
}

export type NewMovement = {
  shopId: string;
  productId: string;
  movementDate: string;
  kind: (typeof STOCK_MOVEMENT_KINDS)[number];
  qtyBase: Milli;
  unitCostPaise: number | null;
  sourceType: string;
  sourceId: string;
  reason: string | null;
  createdBy: string;
};

/** Appends one movement and moves the cache by the same amount, in the caller's transaction. */
export async function appendMovement(tx: Transaction, movement: NewMovement): Promise<number> {
  const [row] = await tx
    .insert(stockMovements)
    .values({ ...movement, qtyBase: toDbQuantity(movement.qtyBase) })
    .returning({ id: stockMovements.id });
  await tx
    .insert(stockLevels)
    .values({ productId: movement.productId, shopId: movement.shopId, qtyBase: toDbQuantity(movement.qtyBase), lastMovementId: row!.id })
    .onConflictDoUpdate({
      target: stockLevels.productId,
      set: { qtyBase: sql`${stockLevels.qtyBase} + excluded.qty_base`, lastMovementId: sql`excluded.last_movement_id`, updatedAt: sql`now()` },
    });
  return row!.id;
}
