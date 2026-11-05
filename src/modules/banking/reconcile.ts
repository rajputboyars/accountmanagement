import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { bookBalanceOn, listBankAccounts } from "@/modules/accounting";
import { recordAudit } from "@/modules/audit";
import { requirePermission, type SessionContext } from "@/modules/identity";
import { withIdempotency } from "@/modules/sync";
import { getDb, withTransaction } from "@/server/db";
import { ConflictError, ValidationError } from "@/server/errors";
import { explainDifference, reconciliationDifference } from "@/shared/bank";
import { indiaDate } from "@/shared/financial-year";
import { formatPaise, parseRupeesToPaise } from "@/shared/money";
import { actorOf, BANK_MANAGE, isRealDate, lastFinalizedDate, loadBank, num, requireBooks, type Db, type LoadedBank } from "./common";
import { listOpenItemsForReconcile } from "./open-items";
import { bankReconciliations } from "./schema";

/**
 * Reconciliation: does the bank statement agree with the books? The statement balance is compared with the book balance, less what
 * the bank has not seen yet (payments not yet cleared, deposits on their way), plus lines on the statement the books do not have,
 * plus the difference the account started with. A reconciliation can only be finished when every line has been explained and
 * nothing is left unexplained; once finished it is never changed, and the days it covers are closed to matching.
 */

const idKey = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, "Something went wrong. Reload the page and try again.");

function balanceToPaise(value: string): number | null {
  const negative = value.trim().startsWith("-");
  const paise = parseRupeesToPaise(value.trim().replace(/^-/, "") || "0");
  return paise === null ? null : negative ? -paise : paise;
}

export type OutstandingItem = { date: string; signedPaise: number; label: string; partyName: string | null; reference: string | null };

export type ReconciliationFigures = {
  bankAccountId: string;
  statementDate: string;
  statementBalancePaise: number;
  bookBalancePaise: number;
  openingGapPaise: number;
  bookNotInBankPaise: number;
  bankNotInBooksPaise: number;
  /** Part of the above that the owner chose to leave out of the books on purpose. */
  ignoredPaise: number;
  differencePaise: number;
  explanation: "balanced" | "bank_has_more" | "books_have_more";
  /** What the statement's own lines add up to; when it differs from the balance entered, lines may be missing from the import. */
  linesBalancePaise: number;
  linesMismatch: boolean;
  unresolvedLines: number;
  matchedCount: number;
  outstanding: OutstandingItem[];
  /** UPI, card and cheque money still waiting to reach any bank: shown for information, not part of this account's figures. */
  waitingForBankPaise: number;
  canFinish: boolean;
};

async function figures(db: Db, shopId: string, bank: LoadedBank, statementDate: string, statementBalancePaise: number): Promise<ReconciliationFigures> {
  const book = await bookBalanceOn(db, shopId, bank.accountId, statementDate);
  const outstanding = await listOpenItemsForReconcile(db, shopId, bank, statementDate);
  const bookNotInBank = outstanding.reduce((sum, item) => sum + item.signedPaise, 0);
  const lines = await db.execute<{ status: string; reason: string | null; signed: string; n: string }>(sql`
    select status, ignore_reason as reason, coalesce(sum(credit_paise - debit_paise), 0)::text as signed, count(*)::text as n
    from bank_statement_lines where shop_id = ${shopId}::uuid and bank_account_id = ${bank.id}::uuid and txn_date > ${bank.openingAsOf}::date and txn_date <= ${statementDate}::date
    group by status, ignore_reason`);
  let notInBooks = 0;
  let ignored = 0;
  let unresolved = 0;
  let matched = 0;
  let all = 0;
  for (const row of lines.rows) {
    const signed = num(row.signed);
    all += signed;
    if (row.status === "matched") matched += num(row.n);
    else {
      notInBooks += signed;
      if (row.status === "ignored") ignored += signed;
      else unresolved += num(row.n);
    }
  }
  const waiting = await db.execute<{ amount: string }>(sql`
    select coalesce(sum(jl.debit_paise - jl.credit_paise), 0)::text as amount from journal_lines jl join journals j on j.id = jl.journal_id
    where jl.shop_id = ${shopId}::uuid and j.entry_date <= ${statementDate}::date and jl.account_id in (select id from accounts where shop_id = ${shopId}::uuid and system_key in ('upi', 'card', 'cheques'))`);
  const difference = reconciliationDifference({ statementBalancePaise, bookBalancePaise: book, openingStatementPaise: bank.openingStatementPaise, openingBookPaise: bank.openingBookPaise, bookNotInBankPaise: bookNotInBank, bankNotInBooksPaise: notInBooks });
  const linesBalance = bank.openingStatementPaise + all;
  return {
    bankAccountId: bank.id,
    statementDate,
    statementBalancePaise,
    bookBalancePaise: book,
    openingGapPaise: bank.openingStatementPaise - bank.openingBookPaise,
    bookNotInBankPaise: bookNotInBank,
    bankNotInBooksPaise: notInBooks,
    ignoredPaise: ignored,
    differencePaise: difference,
    explanation: explainDifference(difference),
    linesBalancePaise: linesBalance,
    linesMismatch: linesBalance !== statementBalancePaise,
    unresolvedLines: unresolved,
    matchedCount: matched,
    outstanding: outstanding.map((item) => ({ date: item.date, signedPaise: item.signedPaise, label: item.label, partyName: item.partyName, reference: item.reference })),
    waitingForBankPaise: num(waiting.rows[0]?.amount),
    canFinish: unresolved === 0 && difference === 0,
  };
}

const previewSchema = z.object({
  bankAccountId: z.string().uuid(),
  statementDate: z.string().refine(isRealDate, "Choose the statement's closing date."),
  statementBalance: z.string().trim().min(1, "Enter the closing balance shown on the statement."),
});

function checkInputs(bank: LoadedBank, data: z.infer<typeof previewSchema>) {
  const balance = balanceToPaise(data.statementBalance);
  if (balance === null) throw new ValidationError("Enter the balance as an amount, for example 25000 or 25,000.50.", { fieldErrors: { statementBalance: "Enter an amount." } });
  if (data.statementDate <= bank.openingAsOf) throw new ValidationError(`Choose a date after ${bank.openingAsOf}, when this account was added.`, { fieldErrors: { statementDate: "Too early." } });
  if (data.statementDate > indiaDate()) throw new ValidationError("The statement date cannot be in the future.", { fieldErrors: { statementDate: "Not in the future." } });
  return balance;
}

/** The live figures for a statement date and closing balance, with what is still unexplained. Saves nothing. */
export async function previewReconciliation(session: SessionContext, input: unknown): Promise<ReconciliationFigures & { lastFinalized: string | null }> {
  await requirePermission(session, BANK_MANAGE);
  const data = previewSchema.parse(input);
  const db = getDb();
  await requireBooks(db, session.shopId);
  const bank = await loadBank(db, session.shopId, data.bankAccountId);
  const balance = checkInputs(bank, data);
  return { ...(await figures(db, session.shopId, bank, data.statementDate, balance)), lastFinalized: await lastFinalizedDate(db, session.shopId, bank.id) };
}

const finalizeSchema = previewSchema.extend({ idempotencyKey: idKey, note: z.string().trim().max(300).optional().transform((value) => value || null) });

export type FinalizedReconciliation = { id: string; differencePaise: number; replayed: boolean };

export async function finalizeReconciliation(session: SessionContext, input: unknown): Promise<FinalizedReconciliation> {
  await requirePermission(session, BANK_MANAGE);
  const { idempotencyKey, note, ...data } = finalizeSchema.parse(input);
  return withTransaction(async (tx) => {
    const outcome = await withIdempotency<{ id: string; differencePaise: number }>(tx, { shopId: session.shopId, userId: session.userId, key: idempotencyKey }, { action: "bank.reconcile", ...data, note }, async () => {
      await requireBooks(tx, session.shopId);
      // One reconciliation at a time per account.
      const bank = await loadBank(tx, session.shopId, data.bankAccountId, { lock: true });
      const balance = checkInputs(bank, data);
      const last = await lastFinalizedDate(tx, session.shopId, bank.id);
      if (last && data.statementDate <= last) throw new ConflictError("ALREADY_RECONCILED", `This account is already reconciled up to ${last}. Choose a later date.`);
      const result = await figures(tx, session.shopId, bank, data.statementDate, balance);
      if (result.unresolvedLines > 0) throw new ConflictError("UNRESOLVED_LINES", `Some statement lines are still not explained (${result.unresolvedLines} to go). Match, post or leave them out first.`);
      if (result.differencePaise !== 0) {
        throw new ConflictError("NOT_BALANCED", `The books and the statement still differ by ${formatPaise(Math.abs(result.differencePaise), { withPaise: true })}. Check the closing balance you entered and the lines you matched.`);
      }
      const [row] = await tx
        .insert(bankReconciliations)
        .values({
          shopId: session.shopId,
          bankAccountId: bank.id,
          statementDate: data.statementDate,
          statementBalancePaise: balance,
          bookBalancePaise: result.bookBalancePaise,
          openingGapPaise: result.openingGapPaise,
          bookNotInBankPaise: result.bookNotInBankPaise,
          bankNotInBooksPaise: result.bankNotInBooksPaise,
          differencePaise: 0,
          linesBalancePaise: result.linesBalancePaise,
          matchedCount: result.matchedCount,
          outstanding: result.outstanding,
          note,
          finalizedBy: session.userId,
        })
        .returning({ id: bankReconciliations.id });
      await recordAudit(tx, actorOf(session), { action: "bank.reconciled", entityType: "bank_reconciliation", entityId: row!.id, after: { bankAccountId: bank.id, statementDate: data.statementDate, statementBalancePaise: balance, bookBalancePaise: result.bookBalancePaise, bookNotInBankPaise: result.bookNotInBankPaise, ignoredPaise: result.ignoredPaise } });
      return { status: 201, body: { id: row!.id, differencePaise: 0 } };
    });
    return { ...outcome.body, replayed: outcome.replayed };
  });
}

export type ReconciliationRow = { id: string; statementDate: string; statementBalancePaise: number; bookBalancePaise: number; bookNotInBankPaise: number; bankNotInBooksPaise: number; openingGapPaise: number; differencePaise: number; matchedCount: number; note: string | null; outstanding: OutstandingItem[]; createdAt: Date };

export async function listReconciliations(session: SessionContext, bankAccountId: string): Promise<ReconciliationRow[]> {
  await requirePermission(session, BANK_MANAGE);
  const db = getDb();
  const bank = await loadBank(db, session.shopId, bankAccountId);
  const rows = await db.select().from(bankReconciliations).where(and(eq(bankReconciliations.shopId, session.shopId), eq(bankReconciliations.bankAccountId, bank.id))).orderBy(desc(bankReconciliations.statementDate)).limit(60);
  return rows.map((row) => ({ id: row.id, statementDate: row.statementDate, statementBalancePaise: row.statementBalancePaise, bookBalancePaise: row.bookBalancePaise, bookNotInBankPaise: row.bookNotInBankPaise, bankNotInBooksPaise: row.bankNotInBooksPaise, openingGapPaise: row.openingGapPaise, differencePaise: row.differencePaise, matchedCount: row.matchedCount, note: row.note, outstanding: row.outstanding as OutstandingItem[], createdAt: row.createdAt }));
}

export type BankOverviewRow = { id: string; name: string; last4: string | null; isDefault: boolean; isActive: boolean; bookBalancePaise: number; lastStatementBalancePaise: number | null; lastStatementDate: string | null; unmatchedLines: number; reconciledThrough: string | null };

/** One line per bank account for the Bank screen: what the books hold, what the latest statement says, and what is left to explain. */
export async function bankOverview(session: SessionContext): Promise<BankOverviewRow[]> {
  const accounts = await listBankAccounts(session);
  const db = getDb();
  const rows: BankOverviewRow[] = [];
  for (const account of accounts) {
    const last = await db.execute<{ balance: string | null; txn_date: string }>(sql`
      select balance_paise::text as balance, txn_date::text from bank_statement_lines
      where shop_id = ${session.shopId}::uuid and bank_account_id = ${account.id}::uuid and balance_paise is not null order by txn_date desc, id desc limit 1`);
    const open = await db.execute<{ n: string }>(sql`select count(*)::text as n from bank_statement_lines where shop_id = ${session.shopId}::uuid and bank_account_id = ${account.id}::uuid and status = 'unmatched'`);
    rows.push({
      id: account.id,
      name: account.name,
      last4: account.last4,
      isDefault: account.isDefault,
      isActive: account.isActive,
      bookBalancePaise: account.bookBalancePaise,
      lastStatementBalancePaise: last.rows[0]?.balance === null || last.rows[0]?.balance === undefined ? null : num(last.rows[0].balance),
      lastStatementDate: last.rows[0]?.txn_date ?? null,
      unmatchedLines: num(open.rows[0]?.n),
      reconciledThrough: await lastFinalizedDate(db, session.shopId, account.id),
    });
  }
  return rows;
}
