import { and, eq, sql } from "drizzle-orm";
import { getDb, type Database, type Transaction } from "@/server/db";
import { LEDGER_KINDS, ledgerEntries, partyBalances } from "./schema";

/**
 * Public API of the ledger module. ledger_entries is the source of truth for what a customer owes
 * (append-only); party_balances is a cache written only here, in the same transaction as the entry.
 * A positive balance means the customer owes the shop; negative is an advance.
 */

/** SUM(debit − credit) for one party, straight from the journal (the v_party_balance definition, scoped to the shop). */
export async function partyBalance(shopId: string, partyType: "customer" | "supplier", partyId: string, db: Database | Transaction = getDb()): Promise<number> {
  const [row] = await db
    .select({ balance: sql<string>`coalesce(sum(${ledgerEntries.debitPaise} - ${ledgerEntries.creditPaise}), 0)::text` })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.shopId, shopId), eq(ledgerEntries.partyType, partyType), eq(ledgerEntries.partyId, partyId)));
  return Number(row?.balance ?? 0);
}

/**
 * Locks a party's cached balance row for the rest of the transaction (creating it first if the
 * party has none yet, so there is always a row to lock). Second in the lock order after stock.
 */
export async function lockPartyBalance(tx: Transaction, shopId: string, partyType: "customer" | "supplier", partyId: string): Promise<void> {
  // A party with entries but no cache row yet starts from its ledger total, never from zero.
  await tx.execute(sql`
    insert into party_balances (party_type, party_id, shop_id, balance_paise, last_entry_id)
    select ${partyType}, ${partyId}::uuid, ${shopId}::uuid, coalesce(sum(debit_paise - credit_paise), 0), coalesce(max(id), 0)
    from ledger_entries where shop_id = ${shopId}::uuid and party_type = ${partyType} and party_id = ${partyId}::uuid
    on conflict (party_type, party_id) do nothing`);
  await tx
    .select({ partyId: partyBalances.partyId })
    .from(partyBalances)
    .where(and(eq(partyBalances.partyType, partyType), eq(partyBalances.partyId, partyId), eq(partyBalances.shopId, shopId)))
    .for("update");
}

export type NewLedgerEntry = {
  shopId: string;
  partyType: "customer" | "supplier";
  partyId: string;
  entryDate: string;
  kind: (typeof LEDGER_KINDS)[number];
  sourceType: string;
  sourceId: string;
  debitPaise?: number;
  creditPaise?: number;
};

/** Appends one entry and moves the cached balance by the same amount. */
export async function appendLedgerEntry(tx: Transaction, entry: NewLedgerEntry): Promise<number> {
  const debit = entry.debitPaise ?? 0;
  const credit = entry.creditPaise ?? 0;
  const [row] = await tx.insert(ledgerEntries).values({ ...entry, debitPaise: debit, creditPaise: credit }).returning({ id: ledgerEntries.id });
  await tx
    .insert(partyBalances)
    .values({ partyType: entry.partyType, partyId: entry.partyId, shopId: entry.shopId, balancePaise: debit - credit, lastEntryId: row!.id })
    .onConflictDoUpdate({
      target: [partyBalances.partyType, partyBalances.partyId],
      set: { balancePaise: sql`${partyBalances.balancePaise} + ${debit - credit}`, lastEntryId: row!.id, updatedAt: sql`now()` },
    });
  return row!.id;
}
