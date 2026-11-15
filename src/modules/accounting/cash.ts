import { sql } from "drizzle-orm";
import type { Database, Transaction } from "@/server/db";
import { loadAccountingSettings } from "./service";

type Db = Database | Transaction;

/**
 * Cash as the books hold it. Once a shop has Business Accounts with their opening saved, the posted Cash account is
 * the one cash figure: the drawer's opening, expected and counted amounts are all read against it. Before that
 * (and for days before the books start) the cashbook keeps its own simple figures, unchanged.
 */
export type CashBasis = { mode: "books"; coverageStartDate: string } | { mode: "cashbook" };

export async function cashBasisFor(db: Db, shopId: string, date: string): Promise<CashBasis> {
  const settings = await loadAccountingSettings(db, shopId);
  if (!settings?.openingRecordedAt || date < settings.coverageStartDate) return { mode: "cashbook" };
  return { mode: "books", coverageStartDate: settings.coverageStartDate };
}

/** What the Cash account holds at the end of a date (every journal dated on or before it), or at all times when `date` is null. */
export async function bookCashOn(db: Db, shopId: string, date: string | null): Promise<number> {
  const result = await db.execute<{ amount: string | null }>(sql`
    select coalesce(sum(l.debit_paise - l.credit_paise), 0)::text as amount
    from journal_lines l
    join journals j on j.id = l.journal_id
    join accounts a on a.id = l.account_id
    where l.shop_id = ${shopId}::uuid and a.system_key = 'cash' ${date ? sql`and j.entry_date <= ${date}::date` : sql``}`);
  return Number(result.rows[0]?.amount ?? 0);
}

/** The cash the opening journal put in the books (what the shop said it had when the books began). */
export async function openingCashInBooks(db: Db, shopId: string): Promise<number> {
  const result = await db.execute<{ amount: string | null }>(sql`
    select coalesce(sum(l.debit_paise - l.credit_paise), 0)::text as amount
    from journal_lines l
    join journals j on j.id = l.journal_id
    join accounts a on a.id = l.account_id
    where l.shop_id = ${shopId}::uuid and a.system_key = 'cash' and j.kind = 'opening'`);
  return Number(result.rows[0]?.amount ?? 0);
}
