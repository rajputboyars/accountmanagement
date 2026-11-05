import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bankAccounts, journalLines, journals } from "../accounting/schema";
import { users } from "../identity/schema";
import { payments } from "../payments/schema";
import { shops } from "../settings/schema";
import { createdAt, id, oneOf, paise } from "../../server/schema-helpers";

/**
 * Owned by the banking module: bank statements the owner imported, the lines on them, how each line was explained
 * (matched to something already in the books, settled from UPI/card/cheque receipts, or posted after the owner confirmed it),
 * and the finished reconciliations. Importing a statement never touches the books; only a confirmed match or posting does.
 * Statement lines and finished reconciliations are never edited; a match can be undone, and the undo is kept.
 */

export const STATEMENT_LINE_STATUSES = ["unmatched", "matched", "ignored"] as const;
export const MATCH_KINDS = ["match", "settlement", "posting"] as const;
export const POSTING_KINDS = ["customer_receipt", "supplier_payment", "bank_charge", "bank_interest", "owner_in", "owner_out"] as const;
export const MATCH_STATUSES = ["active", "undone"] as const;

export const bankStatements = pgTable(
  "bank_statements",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    bankAccountId: uuid("bank_account_id").notNull().references(() => bankAccounts.id),
    fileName: text("file_name").notNull(),
    /** Hash of the file's text: the same file cannot be imported twice. */
    fileHash: text("file_hash").notNull(),
    lineCount: integer("line_count").notNull(),
    newLineCount: integer("new_line_count").notNull(),
    duplicateLineCount: integer("duplicate_line_count").notNull(),
    fromDate: date("from_date", { mode: "string" }),
    toDate: date("to_date", { mode: "string" }),
    importedBy: uuid("imported_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [unique("bank_statements_file_key").on(t.bankAccountId, t.fileHash), index("bank_statements_account_idx").on(t.shopId, t.bankAccountId)],
);

export const bankStatementLines = pgTable(
  "bank_statement_lines",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    statementId: uuid("statement_id").notNull().references(() => bankStatements.id),
    bankAccountId: uuid("bank_account_id").notNull().references(() => bankAccounts.id),
    txnDate: date("txn_date", { mode: "string" }).notNull(),
    narration: text("narration").notNull(),
    reference: text("reference"),
    debitPaise: paise("debit_paise").notNull().default(0),
    creditPaise: paise("credit_paise").notNull().default(0),
    balancePaise: paise("balance_paise"),
    /** Hash of the line's text plus its number among identical lines, so genuine repeats are kept and re-imports are recognised. */
    fingerprint: text("fingerprint").notNull(),
    occurrence: integer("occurrence").notNull(),
    status: text("status").$type<(typeof STATEMENT_LINE_STATUSES)[number]>().notNull().default("unmatched"),
    /** Why a line was left out (for example, before the account was added). Only this and the status can change. */
    ignoreReason: text("ignore_reason"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("bank_statement_lines_fingerprint_key").on(t.bankAccountId, t.fingerprint, t.occurrence),
    index("bank_statement_lines_account_date_idx").on(t.shopId, t.bankAccountId, t.txnDate),
    index("bank_statement_lines_status_idx").on(t.bankAccountId, t.status),
    check("bank_statement_lines_status_check", oneOf(t.status, STATEMENT_LINE_STATUSES)),
    check("bank_statement_lines_amount_check", sql`${t.debitPaise} >= 0 and ${t.creditPaise} >= 0 and (${t.debitPaise} > 0) <> (${t.creditPaise} > 0)`),
    check("bank_statement_lines_occurrence_check", sql`${t.occurrence} >= 1`),
  ],
);

/** One decision about one or more statement lines. A match can be undone: the row stays, marked undone, with who and why. */
export const bankMatchGroups = pgTable(
  "bank_match_groups",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    bankAccountId: uuid("bank_account_id").notNull().references(() => bankAccounts.id),
    kind: text("kind").$type<(typeof MATCH_KINDS)[number]>().notNull(),
    postingKind: text("posting_kind").$type<(typeof POSTING_KINDS)[number]>(),
    /** The payment a posting created, when it created one. */
    paymentId: uuid("payment_id").references(() => payments.id),
    /** The journal a settlement or posting made. Matching something already in the books makes none. */
    journalId: uuid("journal_id").references(() => journals.id),
    /** What the bank kept back when it settled UPI, card or cheque receipts. */
    feePaise: paise("fee_paise").notNull().default(0),
    status: text("status").$type<(typeof MATCH_STATUSES)[number]>().notNull().default("active"),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    undoneBy: uuid("undone_by").references(() => users.id),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    undoReason: text("undo_reason"),
  },
  (t) => [
    index("bank_match_groups_account_idx").on(t.shopId, t.bankAccountId, t.status),
    check("bank_match_groups_kind_check", oneOf(t.kind, MATCH_KINDS)),
    check("bank_match_groups_status_check", oneOf(t.status, MATCH_STATUSES)),
    check("bank_match_groups_fee_check", sql`${t.feePaise} >= 0`),
    check("bank_match_groups_posting_check", sql`(${t.kind} = 'posting') = (${t.postingKind} is not null)`),
  ],
);

export const bankMatchLines = pgTable(
  "bank_match_lines",
  {
    groupId: uuid("group_id").notNull().references(() => bankMatchGroups.id),
    lineId: uuid("line_id").notNull().references(() => bankStatementLines.id),
    active: boolean("active").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.lineId] }), uniqueIndex("bank_match_lines_one_active_key").on(t.lineId).where(sql`${t.active}`)],
);

/** The book entries a decision covers: journal lines on the bank account (direct match) or on the UPI/card/cheque accounts (settlement). */
export const bankMatchItems = pgTable(
  "bank_match_items",
  {
    groupId: uuid("group_id").notNull().references(() => bankMatchGroups.id),
    journalLineId: bigint("journal_line_id", { mode: "number" }).notNull().references(() => journalLines.id),
    /** Debit minus credit of that journal line. */
    signedPaise: paise("signed_paise").notNull(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.journalLineId] }), uniqueIndex("bank_match_items_one_active_key").on(t.journalLineId).where(sql`${t.active}`)],
);

/** A finished reconciliation: the figures as they were, never edited. Later work cannot change a finished period. */
export const bankReconciliations = pgTable(
  "bank_reconciliations",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    bankAccountId: uuid("bank_account_id").notNull().references(() => bankAccounts.id),
    statementDate: date("statement_date", { mode: "string" }).notNull(),
    statementBalancePaise: paise("statement_balance_paise").notNull(),
    bookBalancePaise: paise("book_balance_paise").notNull(),
    openingGapPaise: paise("opening_gap_paise").notNull(),
    bookNotInBankPaise: paise("book_not_in_bank_paise").notNull(),
    bankNotInBooksPaise: paise("bank_not_in_books_paise").notNull(),
    differencePaise: paise("difference_paise").notNull(),
    /** What the statement's own lines add up to, kept so a gap between this and the balance entered stays visible. */
    linesBalancePaise: paise("lines_balance_paise"),
    matchedCount: integer("matched_count").notNull(),
    outstanding: jsonb("outstanding").$type<unknown[]>().notNull(),
    note: text("note"),
    finalizedBy: uuid("finalized_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [unique("bank_reconciliations_date_key").on(t.bankAccountId, t.statementDate), index("bank_reconciliations_account_idx").on(t.shopId, t.bankAccountId, t.statementDate)],
);
