import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/modules/audit";
import { requirePermission, type SessionContext } from "@/modules/identity";
import { getDb, withTransaction, type Database, type Transaction } from "@/server/db";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { costOf, openingStockValued } from "@/shared/accounting";
import { indiaDate } from "@/shared/financial-year";
import { accountingGapResolutions, accountingGaps } from "./schema";
import { ACCOUNTING_MANAGE, loadAccountingSettings, postJournal } from "./service";

/**
 * Giving opening stock a confirmed cost. The owner states the cost (a unit cost or a total value) and where it came from;
 * nothing is estimated. Each confirmation adds a journal (stock up, the other side in clearing until the owner confirms the
 * opening) and a record of who confirmed it and when. No profit account is touched, and nothing posted earlier is changed.
 */

type Db = Database | Transaction;
const MILLI = BigInt(1000);
const dayBefore = (value: string) => new Date(new Date(`${value}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);

function toMilli(text: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(text.trim());
  if (!match) throw new ValidationError("Enter a quantity with up to 3 decimal places.");
  const value = BigInt(match[2]!) * MILLI + BigInt((match[3] ?? "").padEnd(3, "0") || "0");
  return match[1] ? -value : value;
}
function fromMilli(value: bigint): string {
  const negative = value < BigInt(0);
  const abs = negative ? -value : value;
  return `${negative ? "-" : ""}${abs / MILLI}.${String(abs % MILLI).padStart(3, "0")}`;
}

export type OpeningGap = {
  gapId: string;
  productId: string;
  name: string;
  sku: string;
  baseUnit: string;
  /** Units that had no cost at the cutover, units already given a value, and units still to value. */
  quantity: string;
  valuedQuantity: string;
  remainingQuantity: string;
  /** The day the opening balances are as at (the day before the books start). */
  cutoverDate: string;
  valuedPaise: number;
};

async function loadGaps(db: Db, shopId: string, cutoverDate: string, gapId?: string, lock = false): Promise<OpeningGap[]> {
  const result = await db.execute<{ id: string; product_id: string; name: string; sku: string; base_unit: string; qty: string; valued: string; value_paise: string }>(sql`
    select g.id, g.ref as product_id, p.name, p.sku, p.base_unit,
      (case when g.source_type = 'opening_stock'
        then (select coalesce(sum(m.qty_base), 0) from stock_movements m where m.shop_id = g.shop_id and m.product_id = p.id and m.source_type = 'opening_stock' and m.source_id = g.source_id)
        else (select coalesce(sum(m.qty_base), 0) from stock_movements m where m.shop_id = g.shop_id and m.product_id = p.id and m.movement_date <= ${cutoverDate}) end)::text as qty,
      (select coalesce(sum(r.quantity), 0) from accounting_gap_resolutions r where r.gap_id = g.id)::text as valued,
      (select coalesce(sum(r.value_paise), 0) from accounting_gap_resolutions r where r.gap_id = g.id)::text as value_paise
    from accounting_gaps g join products p on p.id::text = g.ref and p.shop_id = g.shop_id
    where g.shop_id = ${shopId} and g.kind = 'unvalued_opening_stock' and g.resolved_at is null
      and (${gapId ?? null}::uuid is null or g.id = ${gapId ?? null}::uuid)
    order by p.name ${lock ? sql`for update of g` : sql``}`);
  return result.rows.map((row) => {
    const quantity = toMilli(row.qty);
    const valued = toMilli(row.valued);
    return { gapId: row.id, productId: row.product_id, name: row.name, sku: row.sku, baseUnit: row.base_unit, quantity: fromMilli(quantity), valuedQuantity: fromMilli(valued), remainingQuantity: fromMilli(quantity - valued), cutoverDate, valuedPaise: Number(row.value_paise) };
  });
}

/** Opening stock still waiting for a confirmed cost. */
export async function listOpeningGaps(session: SessionContext): Promise<OpeningGap[]> {
  await requirePermission(session, ACCOUNTING_MANAGE);
  const settings = await loadAccountingSettings(getDb(), session.shopId);
  if (!settings) return [];
  return loadGaps(getDb(), session.shopId, dayBefore(settings.coverageStartDate));
}

const inputSchema = z.object({
  gapId: z.string().uuid(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, "This form has expired. Reload the page."),
  /** Base units being valued now; leave out to value everything that remains. */
  quantity: z.string().trim().optional(),
  unitCostPaise: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  totalValuePaise: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  source: z.string().trim().min(3, "Write where this cost comes from (at least 3 characters).").max(200),
});

export type ValuedStock = { resolutionId: string; valuePaise: number; remainingQuantity: string; replayed: boolean };

export async function valueOpeningStock(session: SessionContext, input: unknown): Promise<ValuedStock> {
  await requirePermission(session, ACCOUNTING_MANAGE);
  const data = inputSchema.parse(input);
  if ((data.unitCostPaise === undefined) === (data.totalValuePaise === undefined)) throw new ValidationError("Enter either a cost per unit or a total value, not both.");
  return withTransaction(async (tx) => {
    const settings = await loadAccountingSettings(tx, session.shopId);
    if (!settings) throw new ConflictError("ACCOUNTING_OFF", "Turn on Business Accounts first.");
    const cutover = dayBefore(settings.coverageStartDate);
    const [owned] = await tx.select({ id: accountingGaps.id, resolvedAt: accountingGaps.resolvedAt, kind: accountingGaps.kind }).from(accountingGaps).where(and(eq(accountingGaps.id, data.gapId), eq(accountingGaps.shopId, session.shopId))).limit(1);
    if (!owned || owned.kind !== "unvalued_opening_stock") throw new NotFoundError("This item was not found.");
    // A repeat of the same confirmation returns the first result, even after the item has been fully valued.
    const [again] = await tx.select().from(accountingGapResolutions).where(and(eq(accountingGapResolutions.gapId, data.gapId), eq(accountingGapResolutions.idempotencyKey, data.idempotencyKey))).limit(1);
    if (again) {
      const [left] = (await loadGaps(tx, session.shopId, cutover, data.gapId)).filter((gap) => gap.gapId === data.gapId);
      return { resolutionId: again.id, valuePaise: again.valuePaise, remainingQuantity: left?.remainingQuantity ?? "0.000", replayed: true };
    }
    if (owned.resolvedAt) throw new ConflictError("GAP_RESOLVED", "This item already has its cost confirmed.");
    const [gap] = await loadGaps(tx, session.shopId, cutover, data.gapId, true);
    if (!gap) throw new ConflictError("GAP_RESOLVED", "This item already has its cost confirmed.");
    const remaining = toMilli(gap.remainingQuantity);
    const quantity = data.quantity ? toMilli(data.quantity) : remaining;
    if (quantity <= BigInt(0)) throw new ValidationError("Enter a quantity above zero.");
    if (quantity > remaining) throw new ValidationError("That is more than the quantity still waiting for a cost.");
    const valuePaise = data.unitCostPaise !== undefined ? costOf(fromMilli(quantity), data.unitCostPaise) : data.totalValuePaise!;
    if (valuePaise <= 0) throw new ValidationError("The value works out to nothing. Enter a higher cost.");
    const [row] = await tx
      .insert(accountingGapResolutions)
      .values({ shopId: session.shopId, gapId: gap.gapId, idempotencyKey: data.idempotencyKey, quantity: fromMilli(quantity), unitCostPaise: data.unitCostPaise ?? null, valuePaise, source: data.source, confirmedBy: session.userId })
      .returning({ id: accountingGapResolutions.id });
    await postJournal(tx, { shopId: session.shopId, userId: session.userId }, { entryDate: indiaDate(), kind: "adjustment", sourceType: "opening_gap", sourceId: row!.id, memo: `Opening stock valued: ${gap.name}`, draft: openingStockValued(valuePaise) });
    const left = remaining - quantity;
    if (left === BigInt(0)) await tx.update(accountingGaps).set({ resolvedAt: new Date(), resolvedBy: session.userId }).where(eq(accountingGaps.id, gap.gapId));
    await recordAudit(tx, { shopId: session.shopId, userId: session.userId, role: session.role }, {
      action: "accounting.opening_stock_valued",
      entityType: "accounting_gap",
      entityId: gap.gapId,
      after: { productId: gap.productId, quantity: fromMilli(quantity), unitCostPaise: data.unitCostPaise ?? null, valuePaise, remainingQuantity: fromMilli(left), cutoverDate: cutover },
      reason: data.source,
    });
    return { resolutionId: row!.id, valuePaise, remainingQuantity: fromMilli(left), replayed: false };
  });
}
