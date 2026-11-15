import { sql } from "drizzle-orm";
import type { Database, Transaction } from "@/server/db";
import { ConflictError, ValidationError } from "@/server/errors";
import { parseQuantity, toBaseQuantity, type Milli } from "@/shared/quantity";
import type { billInputSchema } from "./validation";
import type { z } from "zod";

/**
 * Billing goods that were already delivered on challans. The bill's lines are built here, on the server, from the delivered lines the
 * person chose: each in the unit and factor it was delivered in, capped at delivered minus already billed (live links only), so several
 * partial bills work and nothing is billed twice. The caller then prices them with the normal pricing, tax, payment and ledger code
 * and posts no stock movement, because the stock left when the goods were delivered.
 */

type ParsedBill = z.output<typeof billInputSchema>;
type Db = Database | Transaction;
const ZERO = BigInt(0);

export type ChallanBillRow = {
  challanLineId: string;
  orderLineId: string;
  orderId: string;
  customerId: string;
  productId: string;
  unit: string;
  factor: Milli;
  qty: Milli;
  base: Milli;
  unitCostPaise: number | null;
  godownId: string;
};

export async function deriveChallanBill(tx: Transaction, shopId: string, bill: ParsedBill, options: { lock: boolean }): Promise<{ bill: ParsedBill; rows: ChallanBillRow[] }> {
  const wanted = bill.challanLines ?? [];
  const ids = [...new Set(wanted.map((line) => line.challanLineId))];
  if (ids.length !== wanted.length) throw new ValidationError("A delivered line can only be on the bill once.");
  const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const found = await tx.execute<{ id: string; order_line_id: string; order_id: string; customer_id: string; product_id: string; unit: string; factor: string; base: string; cost: string | null; godown_id: string; billed: string }>(sql`
    select l.id, l.order_line_id, c.order_id, c.customer_id, l.product_id, l.unit, l.factor::text, l.base_qty::text as base, l.unit_cost_paise::text as cost, c.godown_id,
           coalesce((select sum(k.base_qty) from invoice_challan_links k where k.challan_line_id = l.id and k.released_at is null), 0)::text as billed
    from delivery_challan_lines l join delivery_challans c on c.id = l.challan_id
    where c.shop_id = ${shopId} and c.status = 'delivered' and l.id in (${idList})
    order by l.id ${options.lock ? sql`for update of l` : sql``}`);
  const byId = new Map(found.rows.map((row) => [row.id, row]));
  const rows: ChallanBillRow[] = wanted.map((requested, index) => {
    const row = byId.get(requested.challanLineId);
    if (!row) throw new ValidationError("These goods are not on a live delivery.", { fieldErrors: { [`challanLines.${index}.challanLineId`]: "Not delivered." } });
    let qty: Milli;
    try {
      qty = parseQuantity(requested.quantity);
    } catch {
      throw new ValidationError("Enter a quantity with up to 3 decimal places.", { fieldErrors: { [`challanLines.${index}.quantity`]: "Enter a quantity." } });
    }
    if (qty <= ZERO) throw new ValidationError("Enter a quantity above zero.", { fieldErrors: { [`challanLines.${index}.quantity`]: "Must be above zero." } });
    const factor = parseQuantity(row.factor);
    const base = toBaseQuantity(qty, factor);
    if (base === null) throw new ValidationError("That quantity can't be stored exactly. Use fewer decimal places.", { fieldErrors: { [`challanLines.${index}.quantity`]: "Use fewer decimal places." } });
    const left = parseQuantity(row.base) - parseQuantity(row.billed);
    if (base > left) throw new ConflictError("BILL_TOO_MUCH", "More than was delivered and not yet billed. Check the quantities.", { fieldErrors: { [`challanLines.${index}.quantity`]: "More than is left to bill." } });
    return { challanLineId: row.id, orderLineId: row.order_line_id, orderId: row.order_id, customerId: row.customer_id, productId: row.product_id, unit: row.unit, factor, qty, base, unitCostPaise: row.cost === null ? null : Number(row.cost), godownId: row.godown_id };
  });
  if (rows.length === 0) throw new ValidationError("Choose the delivered goods to bill.");
  if (new Set(rows.map((row) => row.orderId)).size > 1) throw new ValidationError("A bill can cover the goods of one order.");
  const customerId = rows[0]!.customerId;
  if ((bill.customerId ?? null) !== customerId) throw new ConflictError("CUSTOMER_MISMATCH", "These goods were delivered to another customer.");
  return { bill: { ...bill, lines: rows.map((row, index) => ({ productId: row.productId, unit: row.unit, quantity: row.qty, discount: wanted[index]!.discount })) } as ParsedBill, rows };
}

/** Product -> godown for a bill made from delivered goods, from the challans it was billed against. */
export async function challanGodowns(db: Db, shopId: string, invoiceId: string): Promise<Map<string, string>> {
  const rows = await db.execute<{ product_id: string; godown_id: string }>(sql`
    select l.product_id, c.godown_id from invoice_challan_links k join delivery_challan_lines l on l.id = k.challan_line_id join delivery_challans c on c.id = l.challan_id
    where k.shop_id = ${shopId} and k.invoice_id = ${invoiceId} order by k.created_at`);
  const found = new Map<string, string>();
  for (const row of rows.rows) if (!found.has(row.product_id)) found.set(row.product_id, row.godown_id);
  return found;
}
