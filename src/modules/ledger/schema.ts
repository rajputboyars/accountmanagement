import { sql } from "drizzle-orm";
import { bigint, check, date, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { shops } from "../settings/schema";
import { createdAt, oneOf, paise } from "../../server/schema-helpers";

/**
 * Owned by the ledger module.
 * ledger_entries is the SOURCE OF TRUTH for customer and supplier balances and is append-only
 * (a trigger in migration 0002 rejects UPDATE and DELETE). party_balances is a cache, written in
 * the same transaction as each entry and reconciled nightly against v_party_balance.
 */

export const PARTY_TYPES = ["customer", "supplier"] as const;
export const LEDGER_KINDS = [
  "opening",
  "invoice",
  "payment",
  "credit_note",
  "cancellation",
  "correction",
  "purchase",
  "debit_note",
] as const;

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    partyType: text("party_type").$type<(typeof PARTY_TYPES)[number]>().notNull(),
    partyId: uuid("party_id").notNull(),
    entryDate: date("entry_date", { mode: "string" }).notNull(), // the bill or payment date (ageing uses this)
    kind: text("kind").$type<(typeof LEDGER_KINDS)[number]>().notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    debitPaise: paise("debit_paise").notNull().default(0),
    creditPaise: paise("credit_paise").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("ledger_entries_party_idx").on(t.partyType, t.partyId, t.entryDate, t.id),
    uniqueIndex("ledger_entries_source_key").on(t.sourceType, t.sourceId, t.kind, t.partyId),
    check("ledger_entries_party_type_check", oneOf(t.partyType, PARTY_TYPES)),
    check("ledger_entries_kind_check", oneOf(t.kind, LEDGER_KINDS)),
    check("ledger_entries_debit_check", sql`${t.debitPaise} >= 0`),
    check("ledger_entries_credit_check", sql`${t.creditPaise} >= 0`),
    check("ledger_entries_one_side_check", sql`(${t.debitPaise} > 0) <> (${t.creditPaise} > 0)`),
  ],
);

/** Cache only. Rebuilt from ledger_entries; never the place a balance is decided. */
export const partyBalances = pgTable(
  "party_balances",
  {
    partyType: text("party_type").$type<(typeof PARTY_TYPES)[number]>().notNull(),
    partyId: uuid("party_id").notNull(),
    shopId: uuid("shop_id").notNull(),
    balancePaise: paise("balance_paise").notNull(),
    lastEntryId: bigint("last_entry_id", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.partyType, t.partyId] })],
);
