import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, index, pgTable, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { users } from "../identity/schema";
import { shops } from "../settings/schema";
import { ACCOUNT_TYPES, CASH_FLOW_CLASSES, GAP_KINDS, INPUT_GST_POLICIES } from "../../shared/accounting";
import { createdAt, id, oneOf, paise, quantity } from "../../server/schema-helpers";

/**
 * Owned by the accounting module ("Business Accounts"). Double-entry books kept beside, not instead of,
 * the customer and supplier ledgers (ledger_entries). Opt-in: a shop with no accounting_settings row posts nothing.
 * journals and journal_lines are append-only and every journal balances (triggers in migration 0026);
 * a mistake is corrected with a reversing journal.
 */

export const OPENING_STATUSES = ["unverified", "verified"] as const;
export const JOURNAL_KINDS = ["event", "opening", "reversal", "adjustment"] as const;

export const accountingSettings = pgTable(
  "accounting_settings",
  {
    shopId: uuid("shop_id").primaryKey().references(() => shops.id),
    /** Books cover transactions dated on or after this day. Nothing earlier is ever posted. */
    coverageStartDate: date("coverage_start_date", { mode: "string" }).notNull(),
    /** Where input GST goes. "review" decides nothing; "recoverable" and "non_recoverable" are explicit choices. */
    inputGstPolicy: text("input_gst_policy").$type<(typeof INPUT_GST_POLICIES)[number]>().notNull().default("review"),
    /** When the opening balances were saved. A shop with nothing to open still records this, so "opened" never depends on a journal existing. */
    openingRecordedAt: timestamp("opening_recorded_at", { withTimezone: true }),
    openingStatus: text("opening_status").$type<(typeof OPENING_STATUSES)[number]>().notNull().default("unverified"),
    /** Journals dated on or before this day cannot be added. */
    lockThrough: date("lock_through", { mode: "string" }),
    activatedBy: uuid("activated_by").notNull().references(() => users.id),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    check("accounting_settings_gst_policy_check", oneOf(t.inputGstPolicy, INPUT_GST_POLICIES)),
    check("accounting_settings_opening_status_check", oneOf(t.openingStatus, OPENING_STATUSES)),
  ],
);

export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    /** Stable key the posting rules use (src/shared/accounting.ts). Names can be shown in any language. */
    systemKey: text("system_key").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    type: text("type").$type<(typeof ACCOUNT_TYPES)[number]>().notNull(),
    category: text("category").notNull(),
    cashFlow: text("cash_flow").$type<(typeof CASH_FLOW_CLASSES)[number]>().notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique("accounts_shop_system_key_key").on(t.shopId, t.systemKey),
    unique("accounts_shop_code_key").on(t.shopId, t.code),
    check("accounts_type_check", oneOf(t.type, ACCOUNT_TYPES)),
    check("accounts_cash_flow_check", oneOf(t.cashFlow, CASH_FLOW_CLASSES)),
  ],
);

export const journals = pgTable(
  "journals",
  {
    id: id(),
    seq: bigint("seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    entryDate: date("entry_date", { mode: "string" }).notNull(),
    kind: text("kind").$type<(typeof JOURNAL_KINDS)[number]>().notNull().default("event"),
    /** The business document this journal came from, and which posting of it. Together they make a post idempotent. */
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    event: text("event").notNull(),
    memo: text("memo"),
    reversesJournalId: uuid("reverses_journal_id").references((): AnyPgColumn => journals.id),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("journals_source_key").on(t.shopId, t.sourceType, t.sourceId, t.event),
    uniqueIndex("journals_one_reversal_key").on(t.reversesJournalId).where(sql`${t.reversesJournalId} is not null`),
    index("journals_shop_date_idx").on(t.shopId, t.entryDate, t.seq),
    check("journals_kind_check", oneOf(t.kind, JOURNAL_KINDS)),
  ],
);

export const journalLines = pgTable(
  "journal_lines",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    journalId: uuid("journal_id").notNull().references(() => journals.id),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    debitPaise: paise("debit_paise").notNull().default(0),
    creditPaise: paise("credit_paise").notNull().default(0),
    /** Set on Receivables and Payables lines so the control accounts can be tied to the party ledger. */
    partyType: text("party_type"),
    partyId: uuid("party_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("journal_lines_journal_idx").on(t.journalId),
    index("journal_lines_account_idx").on(t.shopId, t.accountId),
    index("journal_lines_party_idx").on(t.partyType, t.partyId),
    check("journal_lines_debit_check", sql`${t.debitPaise} >= 0`),
    check("journal_lines_credit_check", sql`${t.creditPaise} >= 0`),
    check("journal_lines_one_side_check", sql`(${t.debitPaise} > 0) <> (${t.creditPaise} > 0)`),
    check("journal_lines_party_check", sql`(${t.partyType} is null) = (${t.partyId} is null) and (${t.partyType} is null or ${t.partyType} in ('customer', 'supplier'))`),
  ],
);

/**
 * Things that make the books incomplete: stock moved or sold with no known cost. Reports read the unresolved
 * rows so incomplete figures are never shown as complete. Only `resolved_*` may change.
 */
export const accountingGaps = pgTable(
  "accounting_gaps",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    kind: text("kind").$type<(typeof GAP_KINDS)[number]>().notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    /** Usually the product id; part of the key so one document can have one gap per product. */
    ref: text("ref").notNull().default(""),
    entryDate: date("entry_date", { mode: "string" }).notNull(),
    note: text("note"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("accounting_gaps_key").on(t.shopId, t.kind, t.sourceType, t.sourceId, t.ref),
    index("accounting_gaps_open_idx").on(t.shopId, t.entryDate).where(sql`${t.resolvedAt} is null`),
    check("accounting_gaps_kind_check", oneOf(t.kind, GAP_KINDS)),
  ],
);

/**
 * A confirmed cost for opening stock that had none: who confirmed it, when, from what source, for how many units.
 * One row per confirmation (a gap can be resolved in parts); its journal has this row as its source. Append-only.
 */
export const accountingGapResolutions = pgTable(
  "accounting_gap_resolutions",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    gapId: uuid("gap_id").notNull().references(() => accountingGaps.id),
    idempotencyKey: text("idempotency_key").notNull(),
    quantity: quantity("quantity").notNull(),
    /** Set when the owner gave a unit cost; null when they gave a total value. */
    unitCostPaise: paise("unit_cost_paise"),
    valuePaise: paise("value_paise").notNull(),
    source: text("source").notNull(),
    confirmedBy: uuid("confirmed_by").notNull().references(() => users.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("accounting_gap_resolutions_key").on(t.gapId, t.idempotencyKey),
    index("accounting_gap_resolutions_gap_idx").on(t.gapId),
    check("accounting_gap_resolutions_value_check", sql`${t.valuePaise} > 0 and ${t.quantity} > 0`),
  ],
);
