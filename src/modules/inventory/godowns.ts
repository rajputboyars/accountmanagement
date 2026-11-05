import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/modules/audit";
import { convertQuantity, loadProductsForStock, lockProductsForStock } from "@/modules/catalog";
import { requirePermission, type SessionContext } from "@/modules/identity";
import { takeDocumentNumber } from "@/modules/settings";
import { withIdempotency } from "@/modules/sync";
import { getDb, withTransaction, type Database, type Transaction } from "@/server/db";
import { isUniqueViolation } from "@/server/db-errors";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { formatQuantity, parseQuantity, toDbQuantity } from "@/shared/quantity";
import { appendMovement, defaultGodownId, lockCacheRows } from "./ledger";
import { availableStock } from "./reservations";
import { STOCK_ADJUST, STOCK_VIEW } from "./permissions";
import { godowns, stockTransferLines, stockTransfers } from "./schema";

/**
 * Godowns (places stock is kept) and stock transfers between them. Opt-in: every shop has its Main Store silently, and nothing
 * about godowns is shown until the owner adds a second one. A godown is never deleted; turning it off keeps its history.
 */

/** The owner manages godowns from Settings (same permission as the rest of the shop's setup). */
export const GODOWN_MANAGE = "settings.edit" as const;

type Db = Database | Transaction;
const actorOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId, role: session.role });
const UUID = /^[0-9a-f-]{36}$/i;

export type GodownView = { id: string; name: string; isDefault: boolean; isActive: boolean };

export async function godownList(db: Db, shopId: string, options: { includeInactive?: boolean } = {}): Promise<GodownView[]> {
  const rows = await db
    .select({ id: godowns.id, name: godowns.name, isDefault: godowns.isDefault, isActive: godowns.isActive })
    .from(godowns)
    .where(and(eq(godowns.shopId, shopId), options.includeInactive ? undefined : eq(godowns.isActive, true)))
    .orderBy(desc(godowns.isDefault), asc(godowns.name));
  return rows;
}

/** More than one active godown: the point from which pickers and per-godown figures appear. */
export async function hasManyGodowns(db: Db, shopId: string): Promise<boolean> {
  return (await godownList(db, shopId)).length > 1;
}

/**
 * Which godown a stock write uses.
 * - A named godown must be one of the shop's active godowns.
 * - Left out in a one-godown shop: the Main Store (nothing is ever asked).
 * - Left out for a receipt in a many-godown shop: the Main Store (receipts default there unless another place is chosen).
 * - Left out for stock leaving in a many-godown shop: refused, never guessed from where stock happens to be.
 */
export async function resolveGodown(db: Db, shopId: string, requested: string | null | undefined, mode: "receive" | "dispatch"): Promise<string> {
  const active = await godownList(db, shopId);
  if (requested) {
    const found = UUID.test(requested) ? active.find((godown) => godown.id === requested) : undefined;
    if (!found) throw new ValidationError("Choose one of your godowns.", { fieldErrors: { godownId: "Choose a godown." } });
    return found.id;
  }
  if (mode === "dispatch" && active.length > 1) throw new ValidationError("Choose which godown the stock comes from.", { fieldErrors: { godownId: "Choose a godown." } });
  return active.find((godown) => godown.isDefault)?.id ?? defaultGodownId(db, shopId);
}

export async function listGodowns(session: SessionContext, options: { includeInactive?: boolean } = {}): Promise<GodownView[]> {
  await requirePermission(session, STOCK_VIEW);
  return godownList(getDb(), session.shopId, options);
}

const nameSchema = z.string().trim().min(2, "Enter a name of at least 2 letters.").max(60, "Keep the name under 60 characters.");

function duplicateName(error: unknown): never {
  if (isUniqueViolation(error, "godowns_shop_name_key")) throw new ConflictError("GODOWN_EXISTS", "You already have a godown with this name.", { fieldErrors: { name: "Already used." } });
  throw error;
}

export async function createGodown(session: SessionContext, input: unknown): Promise<{ id: string }> {
  await requirePermission(session, GODOWN_MANAGE);
  const name = nameSchema.parse((input as { name?: unknown })?.name);
  try {
    return await withTransaction(async (tx) => {
      await defaultGodownId(tx, session.shopId);
      const [row] = await tx.insert(godowns).values({ shopId: session.shopId, name, createdBy: session.userId }).returning({ id: godowns.id });
      await recordAudit(tx, actorOf(session), { action: "inventory.godown_created", entityType: "godown", entityId: row!.id, after: { name } });
      return { id: row!.id };
    });
  } catch (error) {
    return duplicateName(error);
  }
}

async function loadOwned(tx: Transaction, shopId: string, id: string) {
  if (!UUID.test(id)) throw new NotFoundError("Godown not found.");
  const [row] = await tx.select().from(godowns).where(and(eq(godowns.id, id), eq(godowns.shopId, shopId))).limit(1).for("update");
  if (!row) throw new NotFoundError("Godown not found.");
  return row;
}

export async function renameGodown(session: SessionContext, godownId: string, input: unknown): Promise<void> {
  await requirePermission(session, GODOWN_MANAGE);
  const name = nameSchema.parse((input as { name?: unknown })?.name);
  try {
    await withTransaction(async (tx) => {
      const row = await loadOwned(tx, session.shopId, godownId);
      await tx.update(godowns).set({ name }).where(eq(godowns.id, row.id));
      await recordAudit(tx, actorOf(session), { action: "inventory.godown_renamed", entityType: "godown", entityId: row.id, before: { name: row.name }, after: { name } });
    });
  } catch (error) {
    duplicateName(error);
  }
}

/** Turning a godown off keeps its history. The Main Store cannot be turned off, and a godown must be empty first. */
export async function setGodownActive(session: SessionContext, godownId: string, active: boolean): Promise<void> {
  await requirePermission(session, GODOWN_MANAGE);
  await withTransaction(async (tx) => {
    const row = await loadOwned(tx, session.shopId, godownId);
    if (row.isActive === active) return;
    if (!active) {
      if (row.isDefault) throw new ConflictError("GODOWN_DEFAULT", "The Main Store can't be turned off.");
      const left = await tx.execute<{ n: string }>(sql`select count(*) as n from (select product_id from stock_movements where godown_id = ${row.id} group by product_id having sum(qty_base) <> 0) x`);
      if (Number(left.rows[0]?.n) > 0) throw new ConflictError("GODOWN_NOT_EMPTY", "This godown still has stock. Move it to another godown first.");
    }
    await tx.update(godowns).set({ isActive: active }).where(eq(godowns.id, row.id));
    await recordAudit(tx, actorOf(session), { action: active ? "inventory.godown_activated" : "inventory.godown_deactivated", entityType: "godown", entityId: row.id, before: { isActive: row.isActive }, after: { isActive: active } });
  });
}

export type GodownStockRow = { productId: string; godownId: string; godownName: string; qty: string };

/** Stock per product and godown, straight from the journal. Rows add up to the shop-wide stock. */
export async function godownStock(session: SessionContext, filters: { productId?: string; godownId?: string } = {}): Promise<GodownStockRow[]> {
  await requirePermission(session, STOCK_VIEW);
  const rows = await getDb().execute<{ product_id: string; godown_id: string; name: string; qty: string }>(sql`
    select m.product_id, m.godown_id, g.name, sum(m.qty_base)::text as qty
    from stock_movements m join godowns g on g.id = m.godown_id
    where m.shop_id = ${session.shopId}
      and (${filters.productId ?? null}::uuid is null or m.product_id = ${filters.productId ?? null}::uuid)
      and (${filters.godownId ?? null}::uuid is null or m.godown_id = ${filters.godownId ?? null}::uuid)
    group by m.product_id, m.godown_id, g.name
    having sum(m.qty_base) <> 0
    order by g.name, m.product_id`);
  return rows.rows.map((row) => ({ productId: row.product_id, godownId: row.godown_id, godownName: row.name, qty: row.qty }));
}

const transferLineSchema = z.object({ productId: z.string().regex(UUID, "Choose a product."), unit: z.string().trim().min(1, "Choose a unit."), quantity: z.string().trim().min(1, "Enter a quantity.") });
export const transferInputSchema = z
  .object({
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, "This form has expired. Reload the page."),
    fromGodownId: z.string().regex(UUID, "Choose where the stock is moving from."),
    toGodownId: z.string().regex(UUID, "Choose where the stock is moving to."),
    reason: z.string().trim().max(200, "Keep the note under 200 characters.").optional().default(""),
    lines: z.array(transferLineSchema).min(1, "Add at least one product.").max(100, "Move at most 100 products at a time."),
  })
  .superRefine((data, ctx) => {
    if (data.fromGodownId === data.toGodownId) ctx.addIssue({ code: "custom", path: ["toGodownId"], message: "Choose a different godown to move the stock to." });
    const seen = new Map<string, number>();
    data.lines.forEach((line, index) => {
      const first = seen.get(line.productId);
      if (first !== undefined) ctx.addIssue({ code: "custom", path: ["lines", index, "productId"], message: `This product is already on line ${first + 1}.` });
      else seen.set(line.productId, index);
    });
  });

export type TransferResult = { id: string; number: string; replayed: boolean };

/**
 * Moves stock between two godowns in one transaction. Each line posts an outgoing and an incoming movement (kinds transfer_out and
 * transfer_in, one source, opposite signs, the product's current cost on both), so shop-wide stock, stock value and profit are unchanged
 * and no journal is posted. A repeat of the same request returns the first result.
 */
export async function transferStock(session: SessionContext, input: unknown): Promise<TransferResult> {
  await requirePermission(session, STOCK_ADJUST);
  const data = transferInputSchema.parse(input);
  return withTransaction(async (tx) => {
    const outcome = await withIdempotency<Omit<TransferResult, "replayed">>(tx, { shopId: session.shopId, userId: session.userId, key: data.idempotencyKey }, { action: "inventory.transfer", ...data }, async () => {
      const places = await godownList(tx, session.shopId);
      const from = places.find((godown) => godown.id === data.fromGodownId);
      const to = places.find((godown) => godown.id === data.toGodownId);
      if (!from) throw new ValidationError("Choose a godown to move the stock from.", { fieldErrors: { fromGodownId: "Choose a godown." } });
      if (!to) throw new ValidationError("Choose a godown to move the stock to.", { fieldErrors: { toGodownId: "Choose a godown." } });

      const productIds = data.lines.map((line) => line.productId);
      const products = new Map((await lockProductsForStock(tx, session.shopId, productIds)).map((product) => [product.id, product]));
      await lockCacheRows(tx, session.shopId, productIds, [from.id, to.id]);
      // What can move is what is physically there less what is set aside for confirmed orders.
      const onHand = new Map([...(await availableStock(tx, session.shopId, productIds, { godownId: from.id }))].map(([id, stock]) => [id, { qty: stock.available }]));

      const planned = data.lines.map((line, index) => {
        const product = products.get(line.productId);
        if (!product) throw new ValidationError("Product not found.", { fieldErrors: { [`lines.${index}.productId`]: "Product not found." } });
        let quantity;
        try {
          quantity = parseQuantity(line.quantity);
        } catch {
          throw new ValidationError("Enter a quantity with up to 3 decimal places.", { fieldErrors: { [`lines.${index}.quantity`]: "Enter a quantity." } });
        }
        if (quantity <= BigInt(0)) throw new ValidationError("Enter a quantity above zero.", { fieldErrors: { [`lines.${index}.quantity`]: "Must be above zero." } });
        const converted = convertQuantity(product, line.unit, quantity);
        if ("error" in converted) {
          const message = converted.error === "unit" ? `${product.name} isn't sold in "${line.unit}".` : converted.error === "precision" ? "That quantity can't be stored exactly. Use fewer decimal places." : `${product.baseUnitName} can't be split, so this must come to a whole number of ${product.baseUnit}.`;
          throw new ValidationError(message, { fieldErrors: { [`lines.${index}.${converted.error === "unit" ? "unit" : "quantity"}`]: message } });
        }
        const have = onHand.get(product.id)?.qty ?? BigInt(0);
        if (have < converted.base) {
          throw new ConflictError("NEGATIVE_STOCK", `Only ${formatQuantity(have)} ${product.baseUnit} of ${product.name} in ${from.name}, less than ${formatQuantity(converted.base)}.`, { available: formatQuantity(have), fieldErrors: { [`lines.${index}.quantity`]: `Only ${formatQuantity(have)} here.` } });
        }
        return { product, unit: line.unit, quantity, ...converted };
      });

      const date = indiaDate();
      const { fy, number } = await takeDocumentNumber(tx, session.shopId, "TRF");
      const transferId = randomUUID();
      await tx.insert(stockTransfers).values({ id: transferId, shopId: session.shopId, fy, number, fromGodownId: from.id, toGodownId: to.id, transferDate: date, reason: data.reason || null, createdBy: session.userId });
      await tx.insert(stockTransferLines).values(
        planned.map((line) => ({ transferId, productId: line.product.id, unit: line.unit, factor: toDbQuantity(line.factor), qty: toDbQuantity(line.quantity), baseQty: toDbQuantity(line.base), unitCostPaise: line.product.costPaise })),
      );
      for (const line of planned) {
        const common = { shopId: session.shopId, productId: line.product.id, movementDate: date, unitCostPaise: line.product.costPaise, sourceType: "stock_transfer", sourceId: transferId, reason: number, entered: { qty: toDbQuantity(line.quantity), unit: line.unit, factor: toDbQuantity(line.factor) }, createdBy: session.userId } as const;
        await appendMovement(tx, { ...common, godownId: from.id, kind: "transfer_out", qtyBase: -line.base });
        await appendMovement(tx, { ...common, godownId: to.id, kind: "transfer_in", qtyBase: line.base });
      }
      await recordAudit(tx, actorOf(session), {
        action: "inventory.stock_transferred",
        entityType: "stock_transfer",
        entityId: transferId,
        after: { number, from: from.name, to: to.name, lines: planned.map((line) => ({ productId: line.product.id, qtyBase: formatQuantity(line.base), unit: line.unit, qty: formatQuantity(line.quantity) })) },
        reason: data.reason || undefined,
      });
      return { status: 201, body: { id: transferId, number } };
    });
    return { ...outcome.body, replayed: outcome.replayed };
  });
}

export type TransferView = { id: string; number: string; date: string; from: string; to: string; lines: number; reason: string | null };

export async function listTransfers(session: SessionContext, limit = 30): Promise<TransferView[]> {
  await requirePermission(session, STOCK_VIEW);
  const rows = await getDb().execute<{ id: string; number: string; date: string; from_name: string; to_name: string; lines: string; reason: string | null }>(sql`
    select t.id, t.number, t.transfer_date::text as date, f.name as from_name, g.name as to_name, reason,
           (select count(*) from stock_transfer_lines l where l.transfer_id = t.id) as lines
    from stock_transfers t join godowns f on f.id = t.from_godown_id join godowns g on g.id = t.to_godown_id
    where t.shop_id = ${session.shopId} order by t.created_at desc limit ${limit}`);
  return rows.rows.map((row) => ({ id: row.id, number: row.number, date: row.date, from: row.from_name, to: row.to_name, lines: Number(row.lines), reason: row.reason }));
}

export type TransferOptions = {
  godowns: GodownView[];
  products: { id: string; name: string; sku: string; baseUnit: string; units: { code: string; name: string }[]; qtyByGodown: Record<string, string> }[];
};

/** What the transfer screen offers: the shop's active godowns and the products that hold stock, with each product's units and its stock per godown. */
export async function transferOptions(session: SessionContext): Promise<TransferOptions> {
  await requirePermission(session, STOCK_ADJUST);
  const [places, rows] = await Promise.all([godownList(getDb(), session.shopId), godownStock(session)]);
  const ids = [...new Set(rows.filter((row) => parseQuantity(row.qty) > BigInt(0)).map((row) => row.productId))];
  const products = await loadProductsForStock(session.shopId, ids);
  return {
    godowns: places,
    products: products
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((product) => ({
        id: product.id,
        name: product.name,
        sku: product.sku,
        baseUnit: product.baseUnit,
        units: [{ code: product.baseUnit, name: product.baseUnitName }, ...product.saleUnits.map((unit) => ({ code: unit.code, name: unit.name }))],
        qtyByGodown: Object.fromEntries(rows.filter((row) => row.productId === product.id).map((row) => [row.godownId, row.qty])),
      })),
  };
}
