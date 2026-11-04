import { sql } from "drizzle-orm";
import { requirePermission, type SessionContext } from "@/modules/identity";
import { getDb, withTransaction, type Database, type Transaction } from "@/server/db";
import { ConflictError, ValidationError } from "@/server/errors";
import { costOf } from "@/shared/accounting";
import { indiaDate } from "@/shared/financial-year";
import { ACCOUNTING_MANAGE, loadAccountingSettings, postOpeningWithin } from "./service";

type Db = Database | Transaction;
const num = (value: unknown) => Number(value ?? 0);
const dayBefore = (value: string) => new Date(new Date(`${value}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);

/**
 * The opening balances worked out from the existing records as at the close of the day before the books start,
 * not from today's balances. Only what can be derived reliably is derived:
 * - customer and supplier balances: the party ledger up to that day;
 * - stock: the quantity moved up to that day, valued at the last known cost on or before it (the existing cost
 *   policy is not changed); stock with no known cost is listed as unvalued, never guessed;
 * - cash: only when a day was closed on exactly that day; otherwise the owner counts it.
 * Bank, UPI, card and cheque balances cannot be derived and are entered by the owner.
 */
export type OpeningDerivation = {
  startDate: string;
  asOf: string;
  receivables: { partyId: string; balancePaise: number }[];
  payables: { partyId: string; balancePaise: number }[];
  receivablesPaise: number;
  payablesPaise: number;
  inventoryPaise: number;
  unvaluedProductIds: string[];
  /** The cash counted when the last day before the start was closed; null when that day was not closed. */
  suggestedCashPaise: number | null;
  /** The most recent closed day before the start, for showing "last counted on…". */
  lastClosedDate: string | null;
};

export async function deriveOpeningWithin(db: Db, shopId: string, startDate: string): Promise<OpeningDerivation> {
  const asOf = dayBefore(startDate);
  const party = async (partyType: "customer" | "supplier") =>
    (
      await db.execute<{ party_id: string; balance: string }>(sql`
        select party_id, sum(debit_paise - credit_paise) as balance from ledger_entries
        where shop_id = ${shopId} and party_type = ${partyType} and entry_date <= ${asOf}
        group by party_id having sum(debit_paise - credit_paise) <> 0 order by party_id`)
    ).rows.map((row) => ({ partyId: row.party_id, balancePaise: num(row.balance) }));
  const [receivables, payables] = await Promise.all([party("customer"), party("supplier")]);

  const stock = await db.execute<{ product_id: string; qty: string; unit_cost: string | null }>(sql`
    with q as (
      select product_id, sum(qty_base) as qty from stock_movements
      where shop_id = ${shopId} and movement_date <= ${asOf} group by product_id having sum(qty_base) <> 0
    ), c as (
      select distinct on (product_id) product_id, unit_cost_paise from stock_movements
      where shop_id = ${shopId} and movement_date <= ${asOf} and unit_cost_paise is not null
      order by product_id, movement_date desc, id desc
    )
    select q.product_id, q.qty::text as qty, c.unit_cost_paise as unit_cost from q left join c using (product_id) order by q.product_id`);
  let inventoryPaise = 0;
  const unvalued: string[] = [];
  for (const row of stock.rows) {
    // Negative stock is a data problem, not stock to value: it is left out rather than turned into a gap that cannot be resolved.
    if (Number(row.qty) <= 0) continue;
    if (row.unit_cost === null) unvalued.push(row.product_id);
    else inventoryPaise += costOf(row.qty, num(row.unit_cost));
  }

  const closed = await db.execute<{ business_date: string; counted: string }>(sql`
    select business_date::text as business_date, counted_cash_paise as counted from day_closings
    where shop_id = ${shopId} and status = 'closed' and business_date <= ${asOf} order by business_date desc limit 1`);
  const last = closed.rows[0];
  return {
    startDate,
    asOf,
    receivables,
    payables,
    receivablesPaise: receivables.reduce((sum, row) => sum + row.balancePaise, 0),
    payablesPaise: payables.reduce((sum, row) => sum + row.balancePaise, 0),
    inventoryPaise,
    unvaluedProductIds: unvalued,
    suggestedCashPaise: last && last.business_date === asOf ? num(last.counted) : null,
    lastClosedDate: last?.business_date ?? null,
  };
}

/** Shows the owner what the opening balances would be for a start date, before anything is posted. */
export async function previewOpening(session: SessionContext, startDate: string): Promise<OpeningDerivation> {
  await requirePermission(session, ACCOUNTING_MANAGE);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new ValidationError("Choose a valid date.");
  if (startDate > indiaDate()) throw new ConflictError("ACCOUNTING_START_NOT_REACHED", `Opening balances can be entered from the start date, ${startDate}.`);
  return deriveOpeningWithin(getDb(), session.shopId, startDate);
}

const amount = (label: string, value: unknown) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ValidationError(`${label} must be zero or more, in whole paise.`);
  return value;
};

/**
 * Completes the opening: customers, suppliers and stock are derived on the server as at the day before the books start
 * (never taken from the browser); the owner supplies only what cannot be derived (cash and bank-like balances).
 * Anything that does not balance waits in the clearing account until the owner confirms.
 */
export async function recordDerivedOpening(session: SessionContext, input: { cashPaise: number; bankPaise: number; upiPaise: number; cardPaise: number; chequesPaise: number }) {
  await requirePermission(session, ACCOUNTING_MANAGE);
  const entered = { cashPaise: amount("Cash", input.cashPaise), bankPaise: amount("Bank", input.bankPaise), upiPaise: amount("UPI", input.upiPaise), cardPaise: amount("Card", input.cardPaise), chequesPaise: amount("Cheques", input.chequesPaise) };
  return withTransaction(async (tx) => {
    const settings = await loadAccountingSettings(tx, session.shopId);
    if (!settings) throw new ConflictError("ACCOUNTING_OFF", "Turn on Business Accounts first.");
    if (settings.coverageStartDate > indiaDate()) throw new ConflictError("ACCOUNTING_START_NOT_REACHED", `Opening balances can be entered from the start date, ${settings.coverageStartDate}.`);
    const derived = await deriveOpeningWithin(tx, session.shopId, settings.coverageStartDate);
    return postOpeningWithin(tx, session, { ...entered, receivables: derived.receivables, payables: derived.payables, inventoryPaise: derived.inventoryPaise, other: [], unvaluedProductIds: derived.unvaluedProductIds });
  });
}
