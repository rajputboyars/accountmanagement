import { sql } from "drizzle-orm";
import type { BookItem } from "@/shared/bank";
import { num, type Db, type LoadedBank } from "./common";

export type OpenItem = BookItem & { journalLineId: number; accountKey: string; sourceType: string; sourceId: string; clearing: boolean };

type ItemRow = { id: string; signed: string; date: string; source_type: string; source_id: string; event: string; kind: string; method: string | null; reference: string | null; party_name: string | null; account_key: string };

/**
 * Book entries not yet explained by any statement line. Reversed entries (a payment entered by mistake and then reversed)
 * cancel each other out and are hidden, unless the original was already matched, in which case its reversal stays visible.
 */
export async function openItems(db: Db, shopId: string, bank: LoadedBank, mode: "bank" | "clearing", endDate?: string): Promise<OpenItem[]> {
  const accountFilter =
    mode === "bank"
      ? sql`jl.account_id = ${bank.accountId}::uuid and j.entry_date > ${bank.openingAsOf}::date`
      : sql`jl.account_id in (select id from accounts where shop_id = ${shopId}::uuid and system_key in ('upi', 'card', 'cheques'))`;
  const result = await db.execute<ItemRow>(sql`
    select jl.id::text as id, (jl.debit_paise - jl.credit_paise)::text as signed, j.entry_date::text as date, j.source_type, j.source_id::text as source_id, j.event, j.kind,
           p.method, p.reference, coalesce(c.name, s.name) as party_name, a.system_key as account_key
    from journal_lines jl
    join journals j on j.id = jl.journal_id
    join accounts a on a.id = jl.account_id
    left join payments p on j.source_type = 'payment' and p.id = j.source_id
    left join customers c on p.party_type = 'customer' and c.id = p.party_id
    left join suppliers s on p.party_type = 'supplier' and s.id = p.party_id
    where jl.shop_id = ${shopId}::uuid and ${accountFilter} ${endDate ? sql`and j.entry_date <= ${endDate}::date` : sql``}
      and j.source_type not in ('bank_match_group', 'bank_opening')
      and not exists (select 1 from bank_match_items i where i.journal_line_id = jl.id and i.active)
      and not exists (select 1 from journals r where r.reverses_journal_id = j.id)
      and not (j.kind = 'reversal' and not exists (
        select 1 from journal_lines ol join bank_match_items oi on oi.journal_line_id = ol.id and oi.active
        where ol.journal_id = j.reverses_journal_id and ol.account_id = jl.account_id))
    order by j.entry_date, jl.id`);
  return result.rows.map((row) => {
    const clearing = mode === "clearing";
    const method = row.method ?? (clearing ? (row.account_key === "cheques" ? "cheque" : row.account_key) : null);
    return {
      id: row.id,
      journalLineId: Number(row.id),
      signedPaise: num(row.signed),
      date: row.date,
      reference: row.reference,
      label: row.kind === "reversal" ? "reversal" : row.source_type,
      partyName: row.party_name,
      method,
      accountKey: row.account_key,
      sourceType: row.source_type,
      sourceId: row.source_id,
      clearing,
    };
  });
}


/** Book entries on this bank account up to a date that no statement line explains yet: what the bank has not seen. */
export const listOpenItemsForReconcile = (db: Db, shopId: string, bank: LoadedBank, endDate: string) => openItems(db, shopId, bank, "bank", endDate);
