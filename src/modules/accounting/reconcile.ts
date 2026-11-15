import { sql } from "drizzle-orm";
import type { Database, Transaction } from "@/server/db";

type Db = Database | Transaction;
const num = (value: unknown) => Number(value ?? 0);

export type PartyMismatch = { partyId: string; partyType: "customer" | "supplier"; booksPaise: number; ledgerPaise: number };

export type PartyTieOut = {
  /** False until the opening journal exists: before that the books and the party ledger legitimately differ. */
  ready: boolean;
  receivables: { booksPaise: number; ledgerPaise: number };
  payables: { booksPaise: number; ledgerPaise: number };
  mismatches: PartyMismatch[];
};

/**
 * Receivables and Payables are controls over the customer and supplier ledgers. Per party the books and ledger_entries
 * must agree (debit minus credit); any difference is listed. Neither side is changed here.
 */
export async function reconcileParties(db: Db, shopId: string, openingExists: boolean): Promise<PartyTieOut> {
  const rows = await db.execute<{ party_type: string; party_id: string; books: string; ledger: string }>(sql`
    with books as (
      select l.party_type, l.party_id, sum(l.debit_paise - l.credit_paise) as amount
      from journal_lines l join accounts a on a.id = l.account_id
      where l.shop_id = ${shopId} and a.system_key in ('receivables', 'payables') and l.party_id is not null
      group by l.party_type, l.party_id
    ), ledger as (
      select party_type, party_id, sum(debit_paise - credit_paise) as amount from ledger_entries
      where shop_id = ${shopId} group by party_type, party_id
    )
    select coalesce(b.party_type, g.party_type) as party_type, coalesce(b.party_id, g.party_id) as party_id,
           coalesce(b.amount, 0) as books, coalesce(g.amount, 0) as ledger
    from books b full join ledger g on g.party_type = b.party_type and g.party_id = b.party_id
    order by 1, 2`);
  const tie: PartyTieOut = { ready: openingExists, receivables: { booksPaise: 0, ledgerPaise: 0 }, payables: { booksPaise: 0, ledgerPaise: 0 }, mismatches: [] };
  for (const row of rows.rows) {
    const side = row.party_type === "customer" ? tie.receivables : tie.payables;
    side.booksPaise += num(row.books);
    side.ledgerPaise += num(row.ledger);
    if (num(row.books) !== num(row.ledger)) tie.mismatches.push({ partyId: row.party_id, partyType: row.party_type as "customer" | "supplier", booksPaise: num(row.books), ledgerPaise: num(row.ledger) });
  }
  return tie;
}

/** What the books hold as stock against the existing stock-at-cost figure. A difference is information, not an error: cost policy is unchanged. */
export async function stockValueComparison(db: Db, shopId: string): Promise<{ booksPaise: number; atCostPaise: number; unvaluedProducts: number }> {
  const books = await db.execute<{ amount: string }>(sql`
    select coalesce(sum(l.debit_paise - l.credit_paise), 0) as amount from journal_lines l join accounts a on a.id = l.account_id
    where l.shop_id = ${shopId} and a.system_key = 'inventory'`);
  const cost = await db.execute<{ value: string; unvalued: string }>(sql`
    select coalesce(sum(round(s.qty_base * p.cost_paise)) filter (where p.cost_paise is not null), 0) as value,
           count(distinct s.product_id) filter (where p.cost_paise is null and s.qty_base > 0) as unvalued
    from stock_levels s join products p on p.id = s.product_id where s.shop_id = ${shopId}`);
  return { booksPaise: num(books.rows[0]?.amount), atCostPaise: num(cost.rows[0]?.value), unvaluedProducts: num(cost.rows[0]?.unvalued) };
}
