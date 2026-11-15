import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { postBankEntry, postBankSettlement, postPayment } from "@/modules/accounting";
import { recordAudit } from "@/modules/audit";
import { requirePermission, type SessionContext } from "@/modules/identity";
import { appendLedgerEntry, lockPartyBalance, partyBalance } from "@/modules/ledger";
import { findCustomer, findSupplier } from "@/modules/parties";
import { insertBankReceiptRow, recordSupplierPayment } from "@/modules/payments";
import { takeDocumentNumber } from "@/modules/settings";
import { withIdempotency } from "@/modules/sync";
import { lockDayForWrite } from "@/server/day-lock";
import { isUniqueViolation } from "@/server/db-errors";
import { getDb, withTransaction, type Transaction } from "@/server/db";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { openItems, type OpenItem } from "./open-items";
import { reverseJournalById } from "./reverse";
import type { AnyAccountKey } from "@/shared/accounting";
import { LARGE_FEE_BP, signedLine, suggestDirectMatches, suggestSettlement } from "@/shared/bank";
import { financialYearLabel } from "@/shared/financial-year";
import { formatPaise } from "@/shared/money";
import { actorOf, BANK_MANAGE, booksOf, isUuid, lastFinalizedDate, loadBank, requireBooks, num, type LoadedBank } from "./common";
import { bankMatchGroups, bankMatchItems, bankMatchLines, bankStatementLines, POSTING_KINDS } from "./schema";

/**
 * Explaining each statement line. There are exactly three ways, and each needs the owner's explicit confirmation:
 * - match: the line is something already in the books (a bank payment, a deposit). Nothing new is posted.
 * - settle: the line is UPI, card or cheque money reaching the bank. The receipts were counted when taken, so only the move
 *   from "not yet in bank" to the bank is posted, less any fee. Sales are never counted twice.
 * - post: the line has no record yet (a charge, interest, a customer's transfer...). It is posted only after the owner confirms.
 * Every one is atomic, idempotent, and can be traced to the line it came from.
 */

const SUGGEST_WINDOW_DAYS = 15;
const MAX_LINES_SHOWN = 300;
const dayNumber = (value: string) => Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 86_400_000);

export type StatementLineView = {
  id: string;
  txnDate: string;
  narration: string;
  reference: string | null;
  debitPaise: number;
  creditPaise: number;
  balancePaise: number | null;
  status: string;
  ignoreReason: string | null;
  group: { id: string; kind: string; postingKind: string | null; feePaise: number; undoable: boolean } | null;
};

export type SuggestionView = { lineId: string; kind: "match" | "settlement"; itemIds: string[]; score: number; reasons: string[]; grossPaise: number; feePaise: number };

export type BankWorkbench = {
  lines: StatementLineView[];
  moreLines: boolean;
  bankItems: OpenItem[];
  clearingItems: OpenItem[];
  suggestions: SuggestionView[];
  finalizedThrough: string | null;
};

/** Everything the matching screen needs in one read: the lines, what the books still hold unexplained, and suggestions. */
export async function bankWorkbench(session: SessionContext, bankAccountId: string, filter: "open" | "all" = "open"): Promise<BankWorkbench> {
  await requirePermission(session, BANK_MANAGE);
  const db = getDb();
  const bank = await loadBank(db, session.shopId, bankAccountId);
  const rows = await db.execute<{ id: string; txn_date: string; narration: string; reference: string | null; debit: string; credit: string; balance: string | null; status: string; ignore_reason: string | null; group_id: string | null; kind: string | null; posting_kind: string | null; fee: string | null; payment_id: string | null }>(sql`
    select l.id, l.txn_date::text, l.narration, l.reference, l.debit_paise::text as debit, l.credit_paise::text as credit, l.balance_paise::text as balance, l.status, l.ignore_reason,
           g.id as group_id, g.kind, g.posting_kind, g.fee_paise::text as fee, g.payment_id
    from bank_statement_lines l
    left join bank_match_lines ml on ml.line_id = l.id and ml.active
    left join bank_match_groups g on g.id = ml.group_id
    where l.shop_id = ${session.shopId}::uuid and l.bank_account_id = ${bank.id}::uuid ${filter === "open" ? sql`and l.status = 'unmatched'` : sql`and l.ignore_reason is distinct from 'before_opening'`}
    order by l.txn_date desc, l.id desc limit ${MAX_LINES_SHOWN + 1}`);
  const lines: StatementLineView[] = rows.rows.slice(0, MAX_LINES_SHOWN).map((row) => ({
    id: row.id,
    txnDate: row.txn_date,
    narration: row.narration,
    reference: row.reference,
    debitPaise: num(row.debit),
    creditPaise: num(row.credit),
    balancePaise: row.balance === null ? null : num(row.balance),
    status: row.status,
    ignoreReason: row.ignore_reason,
    group: row.group_id ? { id: row.group_id, kind: row.kind!, postingKind: row.posting_kind, feePaise: num(row.fee), undoable: !row.payment_id } : null,
  }));
  const [bankItems, clearingItems] = await Promise.all([openItems(db, session.shopId, bank, "bank"), openItems(db, session.shopId, bank, "clearing")]);
  const finalizedThrough = await lastFinalizedDate(db, session.shopId, bank.id);

  // Suggestions are only ever shown; each book entry is offered to one line at most.
  const suggestions: SuggestionView[] = [];
  const used = new Set<string>();
  for (const line of lines.filter((candidate) => candidate.status === "unmatched").slice().reverse()) {
    const direct = suggestDirectMatches(line, bankItems.filter((item) => !used.has(item.id)))[0];
    if (direct && direct.score >= 60) {
      direct.itemIds.forEach((id) => used.add(id));
      suggestions.push({ lineId: line.id, kind: "match", itemIds: direct.itemIds, score: direct.score, reasons: direct.reasons, grossPaise: signedLine(line), feePaise: 0 });
      continue;
    }
    const nearby = clearingItems.filter((item) => !used.has(item.id) && dayNumber(line.txnDate) - dayNumber(item.date) <= SUGGEST_WINDOW_DAYS);
    const settle = suggestSettlement(line, nearby);
    if (settle) {
      const gross = nearby.filter((item) => settle.itemIds.includes(item.id)).reduce((sum, item) => sum + item.signedPaise, 0);
      settle.itemIds.forEach((id) => used.add(id));
      suggestions.push({ lineId: line.id, kind: "settlement", itemIds: settle.itemIds, score: settle.score, reasons: settle.reasons, grossPaise: gross, feePaise: gross - signedLine(line) });
    }
  }
  return { lines, moreLines: rows.rows.length > MAX_LINES_SHOWN, bankItems, clearingItems, suggestions, finalizedThrough };
}

// ── Confirming a match or a settlement ────────────────────────────────────────────────────────────

const idKey = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, "Something went wrong. Reload the page and try again.");

export const confirmMatchSchema = z.object({
  idempotencyKey: idKey,
  bankAccountId: z.string().uuid(),
  lineIds: z.array(z.string().uuid()).min(1, "Choose the statement lines to match.").max(50),
  /** Journal line ids of the book entries chosen, from the lists shown. */
  itemIds: z.array(z.coerce.number().int().positive()).min(1, "Choose what in your books these lines belong to.").max(200),
  /** Required before a settlement keeps back more than 3% as a fee. */
  confirmLargeFee: z.boolean().optional(),
});

type LineRow = { id: string; txnDate: string; debitPaise: number; creditPaise: number; status: string; reference: string | null; narration: string };

/** Locks the chosen unmatched lines (in id order, so two people matching the same lines wait for each other) and checks them. */
async function lockLines(tx: Transaction, shopId: string, bank: LoadedBank, lineIds: string[]): Promise<LineRow[]> {
  const ids = [...new Set(lineIds)].sort();
  if (ids.length !== lineIds.length) throw new ValidationError("A line was chosen twice.");
  const rows = await tx
    .select({ id: bankStatementLines.id, txnDate: bankStatementLines.txnDate, debitPaise: bankStatementLines.debitPaise, creditPaise: bankStatementLines.creditPaise, status: bankStatementLines.status, reference: bankStatementLines.reference, narration: bankStatementLines.narration })
    .from(bankStatementLines)
    .where(and(eq(bankStatementLines.shopId, shopId), eq(bankStatementLines.bankAccountId, bank.id), inArray(bankStatementLines.id, ids)))
    .orderBy(asc(bankStatementLines.id))
    .for("update");
  if (rows.length !== ids.length) throw new NotFoundError("A statement line was not found.");
  const closed = await lastFinalizedDate(tx, shopId, bank.id);
  for (const row of rows) {
    if (row.status !== "unmatched") throw new ConflictError("LINE_NOT_OPEN", "One of these lines has already been explained. Reload the page.");
    if (closed && row.txnDate <= closed) throw new ConflictError("PERIOD_RECONCILED", `Everything up to ${closed} has been reconciled and is closed.`);
  }
  return rows;
}

export type MatchResult = { groupId: string; kind: "match" | "settlement"; feePaise: number; replayed: boolean };

export async function confirmMatch(session: SessionContext, input: unknown): Promise<MatchResult> {
  await requirePermission(session, BANK_MANAGE);
  const { idempotencyKey, confirmLargeFee, ...data } = confirmMatchSchema.parse(input);
  return withTransaction(async (tx) => {
    const outcome = await withIdempotency<Omit<MatchResult, "replayed">>(tx, { shopId: session.shopId, userId: session.userId, key: idempotencyKey }, { action: "bank.match", ...data, confirmLargeFee: Boolean(confirmLargeFee) }, async () => {
      await requireBooks(tx, session.shopId);
      const bank = await loadBank(tx, session.shopId, data.bankAccountId);
      const lines = await lockLines(tx, session.shopId, bank, data.lineIds);
      const itemIds = [...new Set(data.itemIds)].sort((a, b) => a - b);
      if (itemIds.length !== data.itemIds.length) throw new ValidationError("An entry was chosen twice.");
      // The chosen entries must be ones the screen could have offered: unexplained, of this shop, on this bank account or a not-yet-in-bank account.
      const bankItems = await openItems(tx, session.shopId, bank, "bank");
      const clearingItems = await openItems(tx, session.shopId, bank, "clearing");
      const picked = itemIds.map((id) => bankItems.find((item) => item.journalLineId === id) ?? clearingItems.find((item) => item.journalLineId === id));
      if (picked.some((item) => !item)) throw new ConflictError("ITEM_NOT_OPEN", "One of these entries is already explained, or is not available here. Reload the page.");
      const items = picked as OpenItem[];
      const statementNet = lines.reduce((sum, line) => sum + signedLine(line), 0);
      const bookTotal = items.reduce((sum, item) => sum + item.signedPaise, 0);
      const clearing = items.filter((item) => item.clearing);
      if (clearing.length > 0 && clearing.length !== items.length) throw new ValidationError("Match bank entries and UPI, card or cheque entries separately.");

      const groupId = randomUUID();
      let kind: "match" | "settlement" = "match";
      let feePaise = 0;
      if (clearing.length === 0) {
        if (statementNet !== bookTotal) {
          throw new ValidationError(`These do not add up: the statement shows ${formatPaise(Math.abs(statementNet), { withPaise: true })} and your books show ${formatPaise(Math.abs(bookTotal), { withPaise: true })}. Choose the right entries, or post the difference separately.`);
        }
      } else {
        kind = "settlement";
        if (statementNet === 0) throw new ValidationError("These lines cancel out. Match them separately.");
        const direction = Math.sign(statementNet);
        if (items.some((item) => Math.sign(item.signedPaise) !== direction)) throw new ValidationError(direction > 0 ? "A bank credit can only settle receipts, not payments." : "A bank debit can only settle payments, not receipts.");
        feePaise = bookTotal - statementNet;
        if (feePaise < 0) throw new ValidationError(`The bank paid ${formatPaise(-feePaise, { withPaise: true })} more than these receipts add up to. Choose more receipts, or check the amounts.`);
        if (feePaise * 10_000 > Math.abs(bookTotal) * LARGE_FEE_BP && !confirmLargeFee) {
          throw new ConflictError("FEE_LARGE", `The bank kept ${formatPaise(feePaise, { withPaise: true })} of ${formatPaise(Math.abs(bookTotal), { withPaise: true })}, which is more than 3%. Check that you chose the right receipts, then confirm the fee.`);
        }
      }

      await tx.insert(bankMatchGroups).values({ id: groupId, shopId: session.shopId, bankAccountId: bank.id, kind, feePaise, createdBy: session.userId });
      try {
        await tx.insert(bankMatchLines).values(lines.map((line) => ({ groupId, lineId: line.id })));
        await tx.insert(bankMatchItems).values(items.map((item) => ({ groupId, journalLineId: item.journalLineId, signedPaise: item.signedPaise })));
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictError("ALREADY_MATCHED", "Someone else has just explained one of these. Reload the page.");
        throw error;
      }
      if (kind === "settlement") {
        const date = [...lines.map((line) => line.txnDate), ...items.map((item) => item.date)].sort().at(-1)!;
        await lockDayForWrite(tx, session.shopId, date);
        const byAccount = new Map<"upi" | "card" | "cheques", number>();
        for (const item of items) byAccount.set(item.accountKey as "upi" | "card" | "cheques", (byAccount.get(item.accountKey as "upi" | "card" | "cheques") ?? 0) + item.signedPaise);
        const result = await postBankSettlement(tx, booksOf(session), { groupId, date, bankAccount: bank.accountKey as AnyAccountKey, bankNetPaise: statementNet, clearing: [...byAccount].map(([account, paise]) => ({ account, paise })) });
        if (result.status === "skipped") throw new ConflictError("NOT_POSTED", "This could not be posted to your books. Check that the dates are after your books start.");
        await tx.update(bankMatchGroups).set({ journalId: result.journalId }).where(eq(bankMatchGroups.id, groupId));
      }
      await tx.update(bankStatementLines).set({ status: "matched" }).where(inArray(bankStatementLines.id, lines.map((line) => line.id)));
      await recordAudit(tx, actorOf(session), { action: kind === "settlement" ? "bank.settled" : "bank.matched", entityType: "bank_match_group", entityId: groupId, after: { bankAccountId: bank.id, lineIds: lines.map((line) => line.id), itemIds, statementNetPaise: statementNet, bookPaise: bookTotal, feePaise } });
      return { status: 201, body: { groupId, kind, feePaise } };
    });
    return { ...outcome.body, replayed: outcome.replayed };
  });
}

// ── Undoing ────────────────────────────────────────────────────────────────────────────────────────

export const undoSchema = z.object({ idempotencyKey: idKey, groupId: z.string().uuid(), reason: z.string().trim().min(3, "Say why you are undoing this.").max(200) });

/**
 * Takes a decision back: the lines become unexplained again and the book entries become available. A journal the decision made
 * is reversed, never deleted. A payment created from a line is undone from the payment's own page (its reversal), not here.
 */
export async function undoMatch(session: SessionContext, input: unknown): Promise<{ groupId: string; replayed: boolean }> {
  await requirePermission(session, BANK_MANAGE);
  const { idempotencyKey, ...data } = undoSchema.parse(input);
  return withTransaction(async (tx) => {
    const outcome = await withIdempotency<{ groupId: string }>(tx, { shopId: session.shopId, userId: session.userId, key: idempotencyKey }, { action: "bank.undo", ...data }, async () => {
      const [group] = await tx.select().from(bankMatchGroups).where(and(eq(bankMatchGroups.id, data.groupId), eq(bankMatchGroups.shopId, session.shopId))).limit(1).for("update");
      if (!group) throw new NotFoundError("Match not found.");
      if (group.status === "undone") throw new ConflictError("ALREADY_UNDONE", "This has already been undone.");
      if (group.paymentId) throw new ConflictError("HAS_PAYMENT", "This line created a payment. To undo it, reverse that receipt or payment from its own page.");
      const bank = await loadBank(tx, session.shopId, group.bankAccountId);
      const lineRows = await tx
        .select({ id: bankStatementLines.id, txnDate: bankStatementLines.txnDate })
        .from(bankMatchLines)
        .innerJoin(bankStatementLines, eq(bankStatementLines.id, bankMatchLines.lineId))
        .where(eq(bankMatchLines.groupId, group.id))
        .orderBy(asc(bankStatementLines.id))
        .for("update", { of: bankStatementLines });
      const closed = await lastFinalizedDate(tx, session.shopId, bank.id);
      if (closed && lineRows.some((row) => row.txnDate <= closed)) throw new ConflictError("PERIOD_RECONCILED", `Everything up to ${closed} has been reconciled and is closed.`);
      if (group.journalId) await reverseJournalById(tx, booksOf(session), group.journalId, `Undone: ${data.reason}`);
      await tx.update(bankMatchGroups).set({ status: "undone", undoneBy: session.userId, undoneAt: new Date(), undoReason: data.reason }).where(eq(bankMatchGroups.id, group.id));
      await tx.update(bankMatchLines).set({ active: false }).where(eq(bankMatchLines.groupId, group.id));
      await tx.update(bankMatchItems).set({ active: false }).where(eq(bankMatchItems.groupId, group.id));
      await tx.update(bankStatementLines).set({ status: "unmatched" }).where(inArray(bankStatementLines.id, lineRows.map((row) => row.id)));
      await recordAudit(tx, actorOf(session), { action: "bank.unmatched", entityType: "bank_match_group", entityId: group.id, before: { kind: group.kind, status: "active" }, after: { status: "undone" }, reason: data.reason });
      return { status: 200, body: { groupId: group.id } };
    });
    return { ...outcome.body, replayed: outcome.replayed };
  });
}

// ── Ignoring a line ────────────────────────────────────────────────────────────────────────────────

export const ignoreSchema = z.object({ lineId: z.string().uuid(), reason: z.string().trim().min(3, "Say why this line is left out.").max(200) });

/** Leaves a line out of the books on purpose (for example, a personal transaction). It stays visible and is counted as a known difference. */
export async function ignoreLine(session: SessionContext, input: unknown): Promise<void> {
  await requirePermission(session, BANK_MANAGE);
  const data = ignoreSchema.parse(input);
  await withTransaction(async (tx) => {
    const [line] = await tx.select().from(bankStatementLines).where(and(eq(bankStatementLines.id, data.lineId), eq(bankStatementLines.shopId, session.shopId))).limit(1).for("update");
    if (!line) throw new NotFoundError("Statement line not found.");
    if (line.status !== "unmatched") throw new ConflictError("LINE_NOT_OPEN", "This line has already been explained.");
    const closed = await lastFinalizedDate(tx, session.shopId, line.bankAccountId);
    if (closed && line.txnDate <= closed) throw new ConflictError("PERIOD_RECONCILED", `Everything up to ${closed} has been reconciled and is closed.`);
    await tx.update(bankStatementLines).set({ status: "ignored", ignoreReason: data.reason }).where(eq(bankStatementLines.id, line.id));
    await recordAudit(tx, actorOf(session), { action: "bank.line_ignored", entityType: "bank_statement_line", entityId: line.id, reason: data.reason });
  });
}

export async function restoreLine(session: SessionContext, lineId: string): Promise<void> {
  await requirePermission(session, BANK_MANAGE);
  if (!isUuid(lineId)) throw new NotFoundError("Statement line not found.");
  await withTransaction(async (tx) => {
    const [line] = await tx.select().from(bankStatementLines).where(and(eq(bankStatementLines.id, lineId), eq(bankStatementLines.shopId, session.shopId))).limit(1).for("update");
    if (!line) throw new NotFoundError("Statement line not found.");
    if (line.status !== "ignored" || line.ignoreReason === "before_opening") throw new ConflictError("LINE_NOT_IGNORED", "This line was not left out by you.");
    const closed = await lastFinalizedDate(tx, session.shopId, line.bankAccountId);
    if (closed && line.txnDate <= closed) throw new ConflictError("PERIOD_RECONCILED", `Everything up to ${closed} has been reconciled and is closed.`);
    await tx.update(bankStatementLines).set({ status: "unmatched", ignoreReason: null }).where(eq(bankStatementLines.id, line.id));
    await recordAudit(tx, actorOf(session), { action: "bank.line_restored", entityType: "bank_statement_line", entityId: line.id });
  });
}

// ── Posting a line nothing explains ─────────────────────────────────────────────────────────────────

const CREDIT_KINDS = ["customer_receipt", "bank_interest", "owner_in", "cash_deposited"] as const;

export const postLineSchema = z.object({
  idempotencyKey: idKey,
  lineId: z.string().uuid(),
  kind: z.enum(POSTING_KINDS, { message: "Choose what this line is." }),
  partyId: z.string().uuid().optional().or(z.literal("").transform(() => undefined)),
  /** The owner must tick the box: nothing is posted from a statement line without it. */
  confirm: z.literal(true, { message: "Confirm that you want this added to your books." }),
});

export type PostLineResult = { groupId: string; paymentId: string | null; replayed: boolean };

export async function postLine(session: SessionContext, input: unknown): Promise<PostLineResult> {
  await requirePermission(session, BANK_MANAGE);
  const { idempotencyKey, ...data } = postLineSchema.parse(input);
  return withTransaction(async (tx) => {
    const outcome = await withIdempotency<Omit<PostLineResult, "replayed">>(tx, { shopId: session.shopId, userId: session.userId, key: idempotencyKey }, { action: "bank.post", ...data }, async () => {
      const settings = await requireBooks(tx, session.shopId);
      const [peek] = await tx.select({ bankAccountId: bankStatementLines.bankAccountId }).from(bankStatementLines).where(and(eq(bankStatementLines.id, data.lineId), eq(bankStatementLines.shopId, session.shopId))).limit(1);
      if (!peek) throw new NotFoundError("Statement line not found.");
      const bank = await loadBank(tx, session.shopId, peek.bankAccountId);
      const [line] = await lockLines(tx, session.shopId, bank, [data.lineId]);
      const isCredit = line!.creditPaise > 0;
      const amount = isCredit ? line!.creditPaise : line!.debitPaise;
      if ((CREDIT_KINDS as readonly string[]).includes(data.kind) !== isCredit) {
        throw new ValidationError(isCredit ? "This is money received, so it cannot be a payment or a charge." : "This is money paid out, so it cannot be a receipt, interest or money put in.");
      }
      if (line!.txnDate < settings.coverageStartDate) throw new ConflictError("BEFORE_BOOKS", `This line is dated before your books start (${settings.coverageStartDate}). Leave it out instead.`);
      await lockDayForWrite(tx, session.shopId, line!.txnDate);

      const groupId = randomUUID();
      const date = line!.txnDate;
      let paymentId: string | null = null;
      await tx.insert(bankMatchGroups).values({ id: groupId, shopId: session.shopId, bankAccountId: bank.id, kind: "posting", postingKind: data.kind, createdBy: session.userId });
      if (data.kind === "customer_receipt") {
        if (!data.partyId) throw new ValidationError("Choose the customer.", { fieldErrors: { partyId: "Choose the customer." } });
        const customer = await findCustomer(session.shopId, data.partyId, tx);
        if (customer.type === "walkin") throw new ConflictError("WALKIN_NO_ACCOUNT", "The walk-in customer has no account to pay into.");
        await lockPartyBalance(tx, session.shopId, "customer", customer.id);
        const { fy, number } = await takeDocumentNumber(tx, session.shopId, "RCPT");
        try {
          paymentId = await insertBankReceiptRow(tx, { shopId: session.shopId, fy, receiptNumber: number, customerId: customer.id, amountPaise: amount, reference: line!.reference, bankAccountId: bank.id, businessDate: date, recordedBy: session.userId });
        } catch (error) {
          if (isUniqueViolation(error)) throw new ConflictError("PAYMENT_EXISTS", "A payment with this reference is already recorded. Match it instead of adding it again.");
          throw error;
        }
        await appendLedgerEntry(tx, { shopId: session.shopId, partyType: "customer", partyId: customer.id, entryDate: date, kind: "payment", sourceType: "payment", sourceId: paymentId, creditPaise: amount });
        await postPayment(tx, booksOf(session), { paymentId, date, direction: "in", partyType: "customer", partyId: customer.id, method: "bank", amountPaise: amount, bankAccountKey: bank.accountKey });
      } else if (data.kind === "supplier_payment") {
        if (!data.partyId) throw new ValidationError("Choose the supplier.", { fieldErrors: { partyId: "Choose the supplier." } });
        const supplier = await findSupplier(session.shopId, data.partyId, tx);
        await lockPartyBalance(tx, session.shopId, "supplier", supplier.id);
        const owed = -(await partyBalance(session.shopId, "supplier", supplier.id, tx));
        if (amount > Math.max(owed, 0)) throw new ConflictError("OVERPAYMENT", owed > 0 ? `You owe ${supplier.name} ${formatPaise(owed, { withPaise: true })}; this is more than that.` : `You don't owe ${supplier.name} anything right now.`);
        try {
          paymentId = await recordSupplierPayment(tx, { shopId: session.shopId, fy: financialYearLabel(), supplierId: supplier.id, method: "bank", amountPaise: amount, reference: line!.reference, businessDate: date, recordedBy: session.userId, bankAccountId: bank.id });
        } catch (error) {
          if (isUniqueViolation(error)) throw new ConflictError("PAYMENT_EXISTS", "A payment with this reference is already recorded. Match it instead of adding it again.");
          throw error;
        }
        await appendLedgerEntry(tx, { shopId: session.shopId, partyType: "supplier", partyId: supplier.id, entryDate: date, kind: "payment", sourceType: "payment", sourceId: paymentId, debitPaise: amount });
        await postPayment(tx, booksOf(session), { paymentId, date, direction: "out", partyType: "supplier", partyId: supplier.id, method: "bank", amountPaise: amount, bankAccountKey: bank.accountKey });
      } else {
        const result = await postBankEntry(tx, booksOf(session), { groupId, date, kind: data.kind, bankAccount: bank.accountKey as AnyAccountKey, amountPaise: amount });
        if (result.status === "skipped") throw new ConflictError("NOT_POSTED", "This could not be posted to your books.");
        await tx.update(bankMatchGroups).set({ journalId: result.journalId }).where(eq(bankMatchGroups.id, groupId));
      }
      // The new book entry on the bank account is what this line explains.
      const own = await tx.execute<{ id: string; signed: string }>(
        paymentId
          ? sql`select jl.id::text, (jl.debit_paise - jl.credit_paise)::text as signed from journal_lines jl join journals j on j.id = jl.journal_id where j.shop_id = ${session.shopId}::uuid and j.source_type = 'payment' and j.source_id = ${paymentId}::uuid and jl.account_id = ${bank.accountId}::uuid`
          : sql`select jl.id::text, (jl.debit_paise - jl.credit_paise)::text as signed from journal_lines jl join journals j on j.id = jl.journal_id where j.shop_id = ${session.shopId}::uuid and j.source_type = 'bank_match_group' and j.source_id = ${groupId}::uuid and jl.account_id = ${bank.accountId}::uuid`,
      );
      if (own.rows.length !== 1) throw new ConflictError("NOT_POSTED", "This could not be posted to your books. Check that the date is after your books start.");
      await tx.insert(bankMatchLines).values({ groupId, lineId: line!.id });
      await tx.insert(bankMatchItems).values({ groupId, journalLineId: Number(own.rows[0]!.id), signedPaise: num(own.rows[0]!.signed) });
      if (paymentId) await tx.update(bankMatchGroups).set({ paymentId }).where(eq(bankMatchGroups.id, groupId));
      await tx.update(bankStatementLines).set({ status: "matched" }).where(eq(bankStatementLines.id, line!.id));
      await recordAudit(tx, actorOf(session), { action: "bank.line_posted", entityType: "bank_match_group", entityId: groupId, after: { lineId: line!.id, kind: data.kind, amountPaise: amount, paymentId, partyId: data.partyId ?? null } });
      return { status: 201, body: { groupId, paymentId } };
    });
    return { ...outcome.body, replayed: outcome.replayed };
  });
}

