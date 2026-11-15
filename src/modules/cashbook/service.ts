import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { bookCashOn, cashBasisFor, openingCashInBooks, postCashDifference, postCashMovement, postCashReconciled, postExpense, postExpenseVoided, resolveBankRoute, reverseJournal } from "@/modules/accounting";
import { recordAudit } from "@/modules/audit";
import { ANY_TARGET, consumeMatchingApproval, hasPermission, loadUserNames, requirePermission, type SessionContext } from "@/modules/identity";
import { paymentsOnDay, paymentTotals } from "@/modules/payments";
import { purchasesDaySummary } from "@/modules/purchasing";
import { salesDaySummary } from "@/modules/sales";
import { loadStaffLimits, shopOpeningCash } from "@/modules/settings";
import { withIdempotency } from "@/modules/sync";
import { lockDayExclusive, lockDayForWrite } from "@/server/day-lock";
import { getDb, withTransaction, type Database, type Transaction } from "@/server/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { DIFFERENCE_REASONS, drawerResult, EXPENSE_CATEGORIES, expectedCash, netCashFlow, type CashFlows } from "@/shared/cashbook";
import { indiaDate } from "@/shared/financial-year";
import { formatPaise, parseRupeesToPaise } from "@/shared/money";
import { cashMovements, cashReconciliations, dayClosings, drawerCounts, expenses } from "./schema";

/**
 * Expenses, cash taken out or put in, and the daily cashbook (spec §6–7). The cashbook is never a
 * separate set of numbers: it is worked out from the payment rows (bills, refunds, supplier payments),
 * expenses and cash movements, so nothing is counted twice. Only cash reaches the drawer; UPI, card,
 * bank, cheque and credit are shown apart. Closing freezes the day's figures in a snapshot and locks
 * that day's money (src/server/day-lock.ts). Cash flow is not profit.
 */

export const CASH_VIEW = "cash.view" as const;
export const CASH_RECORD = "cash.record" as const;
export const DAY_CLOSE = "day.close" as const;
export const DAY_REOPEN = "day.reopen" as const;
export const DRAWER_COUNT = "drawer.count" as const;
export const CASH_RECONCILE = "cash.reconcile" as const;
const EXPENSE_SMALL = "expense.small" as const;

const actorOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId, role: session.role });
const booksOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId });
type Db = Database | Transaction;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const rupees = (label: string) =>
  z
    .string()
    .trim()
    .transform((value, ctx) => {
      const paise = parseRupeesToPaise(value);
      if (paise === null || paise <= 0) {
        ctx.addIssue({ code: "custom", message: `Enter the ${label} in rupees, more than 0.` });
        return z.NEVER;
      }
      return paise;
    });
const businessDate = z
  .string()
  .regex(DATE, "Choose a date.")
  .refine((value) => value <= indiaDate(), "The date can't be in the future.");
const key = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, "This form has expired. Reload the page.");

export const expenseInputSchema = z
  .object({
    idempotencyKey: key,
    businessDate,
    category: z.enum(EXPENSE_CATEGORIES.map((category) => category.key) as [string, ...string[]], { message: "Choose a category." }),
    amount: rupees("amount"),
    method: z.enum(["cash", "upi", "bank"], { message: "Choose how it was paid." }),
    bankAccountId: z.string().uuid().optional().or(z.literal("").transform(() => undefined)),
    note: z
      .string()
      .trim()
      .max(200, "Keep the note under 200 characters.")
      .optional()
      .transform((value) => value || null),
    reference: z
      .string()
      .trim()
      .max(40, "At most 40 characters.")
      .optional()
      .transform((value) => value || null),
  })
  .superRefine((data, ctx) => {
    if (data.category === "other" && !data.note) ctx.addIssue({ code: "custom", path: ["note"], message: "Say what the expense was for." });
  });

export const cashMovementInputSchema = z.object({
  idempotencyKey: key,
  businessDate,
  kind: z.enum(["withdrawal", "bank_deposit", "bank_withdrawal", "float_added"], { message: "Choose what happened." }),
  amount: rupees("amount"),
  bankAccountId: z.string().uuid().optional().or(z.literal("").transform(() => undefined)),
  note: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((value) => value || null),
});

const reasonSchema = z.object({ reason: z.string().trim().min(3, "Write a short reason (at least 3 characters).").max(200) });

export const closeDayInputSchema = z
  .object({
    businessDate,
    counted: z
      .string()
      .trim()
      .transform((value, ctx) => {
        const paise = parseRupeesToPaise(value === "" ? "x" : value);
        if (paise === null) {
          ctx.addIssue({ code: "custom", message: "Enter the cash you counted, in rupees (0 if the drawer is empty)." });
          return z.NEVER;
        }
        return paise;
      }),
    reasonKey: z.string().optional().default(""),
    reasonNote: z.string().trim().max(200).optional().default(""),
  })
  .superRefine((data, ctx) => {
    if (data.reasonKey && !DIFFERENCE_REASONS.some((reason) => reason.key === data.reasonKey)) ctx.addIssue({ code: "custom", path: ["reasonKey"], message: "Choose a reason." });
    if (data.reasonKey === "other" && !data.reasonNote) ctx.addIssue({ code: "custom", path: ["reasonNote"], message: "Explain the difference." });
  });

// ── Figures ──────────────────────────────────────────────────────────────────

function previousDate(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

function nextDate(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

type Flows = Omit<CashFlows, "openingPaise">;
type NonCash = { method: string; inPaise: number; outPaise: number }[];

/** Cash flows and non-cash totals for business dates in [fromDate, toDate]; null from = since the start. */
async function flowsBetween(db: Db, shopId: string, fromDate: string | null, toDate: string): Promise<{ flows: Flows; nonCash: NonCash }> {
  const flows: Flows = { cashSalesPaise: 0, cashCollectionsPaise: 0, cashAddedPaise: 0, cashRefundsPaise: 0, supplierCashPaidPaise: 0, supplierCashReturnedPaise: 0, cashExpensesPaise: 0, cashWithdrawnPaise: 0 };
  if (fromDate !== null && fromDate > toDate) return { flows, nonCash: [] };
  const byMethod = new Map<string, { inPaise: number; outPaise: number }>();
  for (const row of await paymentTotals(db, shopId, fromDate, toDate)) {
    const into = row.category === "bill" || row.category === "collection" || row.category === "supplier_returned";
    if (row.method === "cash") {
      if (row.category === "bill") flows.cashSalesPaise += row.totalPaise;
      else if (row.category === "collection") flows.cashCollectionsPaise += row.totalPaise;
      else if (row.category === "refund") flows.cashRefundsPaise += row.totalPaise;
      else if (row.category === "supplier_paid") flows.supplierCashPaidPaise += row.totalPaise;
      else flows.supplierCashReturnedPaise += row.totalPaise;
    } else {
      const entry = byMethod.get(row.method) ?? { inPaise: 0, outPaise: 0 };
      if (into) entry.inPaise += row.totalPaise;
      else entry.outPaise += row.totalPaise;
      byMethod.set(row.method, entry);
    }
  }
  const range = (column: typeof expenses.businessDate | typeof cashMovements.businessDate) => and(fromDate ? sql`${column} >= ${fromDate}` : undefined, sql`${column} <= ${toDate}`);
  const expenseRows = await db
    .select({ method: expenses.method, total: sql<string>`sum(${expenses.amountPaise})::text` })
    .from(expenses)
    .where(and(eq(expenses.shopId, shopId), eq(expenses.status, "recorded"), range(expenses.businessDate)))
    .groupBy(expenses.method);
  for (const row of expenseRows) {
    if (row.method === "cash") flows.cashExpensesPaise += Number(row.total);
    else {
      const entry = byMethod.get(row.method) ?? { inPaise: 0, outPaise: 0 };
      entry.outPaise += Number(row.total);
      byMethod.set(row.method, entry);
    }
  }
  const movementRows = await db
    .select({ kind: cashMovements.kind, total: sql<string>`sum(${cashMovements.amountPaise})::text` })
    .from(cashMovements)
    .where(and(eq(cashMovements.shopId, shopId), range(cashMovements.businessDate)))
    .groupBy(cashMovements.kind);
  for (const row of movementRows) {
    if (row.kind === "float_added") flows.cashAddedPaise += Number(row.total);
    else flows.cashWithdrawnPaise += Number(row.total);
  }
  return { flows, nonCash: [...byMethod.entries()].map(([method, totals]) => ({ method, ...totals })) };
}

/**
 * Cash and non-cash movement for a range of business dates (reports), by the same rules as the
 * cashbook. No permission check: the caller does it. Net cash is money into the drawer minus money out;
 * it is not profit and not sales.
 */
export async function cashFlowsForRange(shopId: string, fromDate: string, toDate: string, db: Db = getDb()) {
  const { flows, nonCash } = await flowsBetween(db, shopId, fromDate, toDate);
  return { flows, nonCash, netCashPaise: netCashFlow(flows) };
}

/** Recorded expenses for a range, by category and method (voided ones left out). */
export async function expenseBreakdown(shopId: string, fromDate: string, toDate: string, db: Db = getDb()) {
  const rows = await db
    .select({ category: expenses.category, method: expenses.method, total: sql<string>`sum(${expenses.amountPaise})::text`, count: sql<number>`count(*)::int` })
    .from(expenses)
    .where(and(eq(expenses.shopId, shopId), eq(expenses.status, "recorded"), sql`${expenses.businessDate} >= ${fromDate}`, sql`${expenses.businessDate} <= ${toDate}`))
    .groupBy(expenses.category, expenses.method);
  return rows.map((row) => ({ category: row.category, method: row.method, totalPaise: Number(row.total), count: row.count }));
}

/** Expense rows for a range, newest first (drill-down and CSV), voided ones included and marked. */
export async function expensesInRange(shopId: string, fromDate: string, toDate: string, limit: number, db: Db = getDb()) {
  return db
    .select({ id: expenses.id, businessDate: expenses.businessDate, category: expenses.category, method: expenses.method, amountPaise: expenses.amountPaise, note: expenses.note, status: expenses.status, createdAt: expenses.createdAt })
    .from(expenses)
    .where(and(eq(expenses.shopId, shopId), sql`${expenses.businessDate} >= ${fromDate}`, sql`${expenses.businessDate} <= ${toDate}`))
    .orderBy(desc(expenses.businessDate), desc(expenses.createdAt))
    .limit(limit + 1);
}

/**
 * Opening cash for a day (handoff C13): the cash counted at the last closed day before it, moved on by
 * the cash flows of any days in between that were never closed. Before the first closing, it starts
 * from the shop's opening cash. Cash taken out (bank deposit, withdrawal) counts on the day it is
 * recorded, so "counted ₹18,150 − deposited ₹15,000" reaches the same expected cash.
 */
async function openingCash(db: Db, shopId: string, date: string): Promise<{ openingPaise: number; fromClosedDate: string | null }> {
  // With Business Accounts on, the posted Cash account is the one cash figure: the day opens with what the books held at the end of the day before.
  if ((await cashBasisFor(db, shopId, date)).mode === "books") {
    const [closed] = await db
      .select({ businessDate: dayClosings.businessDate })
      .from(dayClosings)
      .where(and(eq(dayClosings.shopId, shopId), eq(dayClosings.status, "closed"), lt(dayClosings.businessDate, date)))
      .orderBy(desc(dayClosings.businessDate))
      .limit(1);
    return { openingPaise: await bookCashOn(db, shopId, previousDate(date)), fromClosedDate: closed?.businessDate ?? null };
  }
  const [last] = await db
    .select({ businessDate: dayClosings.businessDate, counted: dayClosings.countedCashPaise })
    .from(dayClosings)
    .where(and(eq(dayClosings.shopId, shopId), eq(dayClosings.status, "closed"), lt(dayClosings.businessDate, date)))
    .orderBy(desc(dayClosings.businessDate))
    .limit(1);
  const base = last ? last.counted : await shopOpeningCash(shopId);
  const { flows } = await flowsBetween(db, shopId, last ? nextDate(last.businessDate) : null, previousDate(date));
  return { openingPaise: expectedCash({ ...flows, openingPaise: base }), fromClosedDate: last?.businessDate ?? null };
}

async function dayFigures(db: Db, shopId: string, date: string) {
  const [{ openingPaise, fromClosedDate }, { flows, nonCash }, sales, purchases] = await Promise.all([
    openingCash(db, shopId, date),
    flowsBetween(db, shopId, date, date),
    salesDaySummary(shopId, date, db),
    purchasesDaySummary(shopId, date, db),
  ]);
  const cash: CashFlows = { openingPaise, ...flows };
  const books = (await cashBasisFor(db, shopId, date)).mode === "books";
  // Expected cash in the drawer is the books' Cash balance at the end of the day, so the drawer, the closing and the Money overview are one figure.
  const expectedPaise = books ? await bookCashOn(db, shopId, date) : expectedCash(cash);
  return { cash, expectedPaise, cashFromBooks: books, nonCash, sales, purchases, openingFromClosedDate: fromClosedDate };
}

// ── Cashbook view ────────────────────────────────────────────────────────────

export async function getCashbook(session: SessionContext, date: string) {
  await requirePermission(session, CASH_VIEW);
  const day = DATE.test(date) ? date : indiaDate();
  const db = getDb();
  const [figures, payments, dayExpenses, movements, closing, canClose, canReopen, laterClosed, health, counts, canCount, smallLimits] = await Promise.all([

    dayFigures(db, session.shopId, day),
    paymentsOnDay(db, session.shopId, day),
    db.select().from(expenses).where(and(eq(expenses.shopId, session.shopId), eq(expenses.businessDate, day))).orderBy(asc(expenses.createdAt)),
    db.select().from(cashMovements).where(and(eq(cashMovements.shopId, session.shopId), eq(cashMovements.businessDate, day))).orderBy(asc(cashMovements.createdAt)),
    db.select().from(dayClosings).where(and(eq(dayClosings.shopId, session.shopId), eq(dayClosings.businessDate, day))).then((rows) => rows[0] ?? null),
    hasPermission(session, DAY_CLOSE),
    hasPermission(session, DAY_REOPEN),
    db.select({ businessDate: dayClosings.businessDate }).from(dayClosings).where(and(eq(dayClosings.shopId, session.shopId), eq(dayClosings.status, "closed"), gt(dayClosings.businessDate, day))).limit(1),
    cashHealthOf(db, session.shopId),
    listDrawerCounts(db, session.shopId, day),
    hasPermission(session, DRAWER_COUNT),
    loadStaffLimits(session.shopId, db),
  ]);
  const userIds = [...new Set([...dayExpenses.map((row) => row.createdBy), ...movements.map((row) => row.createdBy), ...(closing ? [closing.closedBy] : [])])];
  const names = await loadUserNames(session.shopId, userIds);
  const closed = closing?.status === "closed";
  return {
    date: day,
    today: indiaDate(),
    ...figures,
    // A closed day keeps what was expected when it was closed: the short or extra posted at close is not counted again.
    expectedPaise: closed && closing ? closing.expectedCashPaise : figures.expectedPaise,
    payments,
    expenses: dayExpenses.map((row) => ({ ...row, createdByName: names.get(row.createdBy) ?? "Unknown user", canVoid: row.status === "recorded" && !closed })),
    movements: movements.map((row) => ({ ...row, createdByName: names.get(row.createdBy) ?? "Unknown user" })),
    closing: closing ? { ...closing, closedByName: names.get(closing.closedBy) ?? "Unknown user" } : null,
    closed,
    health,
    drawerCounts: counts,
    canCount: canCount && !closed,
    canReconcile: health.needsReconciliation && (await hasPermission(session, CASH_RECONCILE)),
    smallExpenseLimitPaise: (await hasPermission(session, CASH_RECORD)) ? null : smallLimits.smallExpensePaise,
    canClose: canClose && !closed && day <= indiaDate() && laterClosed.length === 0,
    canReopen: canReopen && closed && laterClosed.length === 0,
    canRecord: !closed && (await hasPermission(session, CASH_RECORD)),
    /** Sales, credit notes and purchases are for people who may see reports; a cashier sees the drawer. */
    showTotals: await hasPermission(session, "reports.view"),
    canRecordExpense: !closed && ((await hasPermission(session, CASH_RECORD)) || (await hasPermission(session, EXPENSE_SMALL))),
  };
}

export type Cashbook = Awaited<ReturnType<typeof getCashbook>>;

export async function listClosings(session: SessionContext, limit = 30) {
  await requirePermission(session, CASH_VIEW);
  return getDb()
    .select({ businessDate: dayClosings.businessDate, status: dayClosings.status, expectedCashPaise: dayClosings.expectedCashPaise, countedCashPaise: dayClosings.countedCashPaise, differencePaise: dayClosings.differencePaise })
    .from(dayClosings)
    .where(eq(dayClosings.shopId, session.shopId))
    .orderBy(desc(dayClosings.businessDate))
    .limit(limit);
}

// ── Expenses and cash movements ──────────────────────────────────────────────

export async function recordExpense(session: SessionContext, input: unknown): Promise<{ id: string; replayed: boolean }> {
  // Owners and managers record any expense. A cashier may record a small one on their own; a bigger one needs the owner's approval.
  const unrestricted = await hasPermission(session, CASH_RECORD);
  if (!unrestricted) await requirePermission(session, EXPENSE_SMALL);
  const { idempotencyKey, ...data } = expenseInputSchema.parse(input);
  return withTransaction(async (tx) => {
    const outcome = await withIdempotency<{ id: string }>(tx, { shopId: session.shopId, userId: session.userId, key: idempotencyKey }, { action: "cashbook.expense", ...data }, async () => {
      await lockDayForWrite(tx, session.shopId, data.businessDate);
      let approvalId: string | null = null;
      if (!unrestricted) {
        const limit = (await loadStaffLimits(session.shopId, tx)).smallExpensePaise;
        if (data.amount > limit) {
          const used = await consumeMatchingApproval(tx, session, "expense_over_limit", [ANY_TARGET], (payload) => ((payload.amountPaise ?? 0) >= data.amount ? null : "The approved amount is lower than this expense."));
          if (!used) throw new ForbiddenError(`This expense is above your ${formatPaise(limit, { withPaise: false })} limit. Ask the owner to approve it.`);
          approvalId = used.id;
        }
      }
      const route = await resolveBankRoute(tx, session.shopId, data.method, data.bankAccountId);
      const [row] = await tx
        .insert(expenses)
        .values({ shopId: session.shopId, businessDate: data.businessDate, category: data.category, amountPaise: data.amount, method: data.method, note: data.note, reference: data.reference, createdBy: session.userId, approvalId })
        .returning({ id: expenses.id });
      await postExpense(tx, booksOf(session), { expenseId: row!.id, date: data.businessDate, category: data.category, method: data.method, amountPaise: data.amount, bankAccountKey: route.key });
      await recordAudit(tx, actorOf(session), { action: "cashbook.expense_recorded", entityType: "expense", entityId: row!.id, approvalId, after: { ...data, bankAccountId: route.bankAccountId, amountPaise: data.amount, amount: undefined } });
      return { status: 201, body: { id: row!.id } };
    });
    return { ...outcome.body, replayed: outcome.replayed };
  });
}

/**
 * Voids an expense entered by mistake while its day is still open (spec §7: after closing, the day's
 * expenses can't be changed; record a correction on today's date instead). The row stays, marked
 * voided with who and why; it no longer counts in the cashbook.
 */
export async function voidExpense(session: SessionContext, expenseId: string, input: unknown): Promise<void> {
  await requirePermission(session, CASH_RECORD);
  const { reason } = reasonSchema.parse(input);
  if (!/^[0-9a-f-]{36}$/i.test(expenseId)) throw new NotFoundError("Expense not found.");
  await withTransaction(async (tx) => {
    const [found] = await tx.select({ businessDate: expenses.businessDate }).from(expenses).where(and(eq(expenses.id, expenseId), eq(expenses.shopId, session.shopId))).limit(1);
    if (!found) throw new NotFoundError("Expense not found.");
    await lockDayForWrite(tx, session.shopId, found.businessDate);
    const [expense] = await tx.select().from(expenses).where(and(eq(expenses.id, expenseId), eq(expenses.shopId, session.shopId))).limit(1).for("update");
    if (expense!.status === "voided") throw new ConflictError("ALREADY_VOIDED", "This expense is already voided.");
    await tx.update(expenses).set({ status: "voided", voidedAt: new Date(), voidedBy: session.userId, voidReason: reason }).where(and(eq(expenses.id, expenseId), eq(expenses.shopId, session.shopId)));
    await postExpenseVoided(tx, booksOf(session), { expenseId, date: expense!.businessDate });
    await recordAudit(tx, actorOf(session), { action: "cashbook.expense_voided", entityType: "expense", entityId: expenseId, before: { status: "recorded", amountPaise: expense!.amountPaise }, after: { status: "voided" }, reason });
  });
}

export async function recordCashMovement(session: SessionContext, input: unknown): Promise<{ id: string; replayed: boolean }> {
  await requirePermission(session, CASH_RECORD);
  const { idempotencyKey, ...data } = cashMovementInputSchema.parse(input);
  return withTransaction(async (tx) => {
    const outcome = await withIdempotency<{ id: string }>(tx, { shopId: session.shopId, userId: session.userId, key: idempotencyKey }, { action: "cashbook.cash_movement", ...data }, async () => {
      await lockDayForWrite(tx, session.shopId, data.businessDate);
      // A deposit to the bank and a withdrawal from it both name the bank account; they move money between the drawer and the bank, never profit.
      const route = await resolveBankRoute(tx, session.shopId, data.kind === "bank_deposit" || data.kind === "bank_withdrawal" ? "bank" : "cash", data.bankAccountId);
      const [row] = await tx.insert(cashMovements).values({ shopId: session.shopId, businessDate: data.businessDate, kind: data.kind, amountPaise: data.amount, note: data.note, bankAccountId: route.bankAccountId, createdBy: session.userId }).returning({ id: cashMovements.id });
      await postCashMovement(tx, booksOf(session), { movementId: row!.id, date: data.businessDate, kind: data.kind, amountPaise: data.amount, bankAccountKey: route.key });
      await recordAudit(tx, actorOf(session), { action: "cashbook.cash_movement_recorded", entityType: "cash_movement", entityId: row!.id, after: { businessDate: data.businessDate, kind: data.kind, amountPaise: data.amount, bankAccountId: route.bankAccountId, note: data.note } });
      return { status: 201, body: { id: row!.id } };
    });
    return { ...outcome.body, replayed: outcome.replayed };
  });
}

// ── Closing ──────────────────────────────────────────────────────────────────

async function laterClosedDay(tx: Transaction, shopId: string, date: string) {
  const [row] = await tx.select({ businessDate: dayClosings.businessDate }).from(dayClosings).where(and(eq(dayClosings.shopId, shopId), eq(dayClosings.status, "closed"), gt(dayClosings.businessDate, date))).limit(1);
  return row?.businessDate ?? null;
}

/**
 * Closes a business day (owner, spec §7): counts the drawer against the expected cash, needs a reason
 * for any difference, saves a snapshot and locks the day. Takes the exclusive day lock, so no bill,
 * payment or expense for that day can be saved while the snapshot is being taken.
 */
export async function closeDay(session: SessionContext, input: unknown) {
  await requirePermission(session, DAY_CLOSE);
  const data = closeDayInputSchema.parse(input);
  return withTransaction(async (tx) => {
    await lockDayExclusive(tx, session.shopId, data.businessDate);
    const [existing] = await tx.select().from(dayClosings).where(and(eq(dayClosings.shopId, session.shopId), eq(dayClosings.businessDate, data.businessDate))).limit(1).for("update");
    if (existing?.status === "closed") throw new ConflictError("ALREADY_CLOSED", "This day is already closed.");
    const later = await laterClosedDay(tx, session.shopId, data.businessDate);
    if (later) throw new ConflictError("LATER_DAY_CLOSED", `A later day (${later}) is already closed, so this one can't be closed now.`);
    const basis = await cashBasisFor(tx, session.shopId, data.businessDate);
    if (basis.mode === "books") {
      const health = await cashHealthOf(tx, session.shopId);
      if (health.needsReconciliation) throw new ConflictError("CASH_RECONCILIATION_REQUIRED", "The cash in your books and your cashbook don't agree yet. The owner needs to confirm the cash in the drawer before a day can be closed.");
    }
    const figures = await dayFigures(tx, session.shopId, data.businessDate);
    const result = drawerResult(figures.expectedPaise, data.counted);
    if (result.differencePaise !== 0 && !data.reasonKey) {
      throw new ValidationError(`Cash ${result.label === "short" ? "short" : "extra"} by ${formatPaise(Math.abs(result.differencePaise), { withPaise: true })}. Choose a reason before closing.`, { fieldErrors: { reasonKey: "Choose a reason." } });
    }
    const reasonLabel = DIFFERENCE_REASONS.find((reason) => reason.key === data.reasonKey)?.label;
    const differenceReason = result.differencePaise === 0 ? null : [reasonLabel, data.reasonNote].filter(Boolean).join(": ");
    const snapshot = {
      cash: figures.cash,
      nonCash: figures.nonCash,
      sales: { billCount: figures.sales.billCount, salesPaise: figures.sales.salesPaise, creditGivenPaise: figures.sales.creditGivenPaise, cancelledCount: figures.sales.cancelledCount, creditNotesPaise: figures.sales.creditNotesPaise },
      purchasesPaise: figures.purchases.purchasesPaise,
    };
    const values = {
      status: "closed" as const,
      openingCashPaise: figures.cash.openingPaise,
      expectedCashPaise: figures.expectedPaise,
      countedCashPaise: data.counted,
      differencePaise: result.differencePaise,
      differenceReason,
      snapshot,
      closedBy: session.userId,
      closedAt: new Date(),
    };
    let closingId = existing?.id;
    if (existing) await tx.update(dayClosings).set(values).where(eq(dayClosings.id, existing.id));
    else closingId = (await tx.insert(dayClosings).values({ shopId: session.shopId, businessDate: data.businessDate, ...values }).returning({ id: dayClosings.id }))[0]!.id;
    // A short or extra drawer is posted in the same transaction, so book cash equals what was counted the moment the day closes.
    let differenceJournalId: string | null = null;
    if (basis.mode === "books" && result.differencePaise !== 0) {
      const posted = await postCashDifference(tx, booksOf(session), { sourceId: randomUUID(), date: data.businessDate, differencePaise: result.differencePaise });
      if (posted.status !== "posted") throw new ConflictError("NOT_POSTED", "The cash difference could not be added to your books.");
      differenceJournalId = posted.journalId;
      await tx.update(dayClosings).set({ differenceJournalId }).where(eq(dayClosings.id, closingId!));
    }
    await recordAudit(tx, actorOf(session), {
      action: "cashbook.day_closed",
      entityType: "day_closing",
      entityId: data.businessDate,
      after: { expectedCashPaise: figures.expectedPaise, countedCashPaise: data.counted, differencePaise: result.differencePaise, differenceReason, differenceJournalId, cashFromBooks: figures.cashFromBooks, reopenedBefore: Boolean(existing) },
      reason: differenceReason,
    });
    return { expectedPaise: figures.expectedPaise, ...result };
  });
}

/** Reopens a closed day (owner, reason, logged). The snapshot is redone at the next close. */
export async function reopenDay(session: SessionContext, date: string, input: unknown): Promise<void> {
  await requirePermission(session, DAY_REOPEN);
  const { reason } = reasonSchema.parse(input);
  if (!DATE.test(date)) throw new NotFoundError("Day not found.");
  await withTransaction(async (tx) => {
    await lockDayExclusive(tx, session.shopId, date);
    const [closing] = await tx.select().from(dayClosings).where(and(eq(dayClosings.shopId, session.shopId), eq(dayClosings.businessDate, date))).limit(1).for("update");
    if (!closing || closing.status !== "closed") throw new ConflictError("NOT_CLOSED", "This day is not closed.");
    const later = await laterClosedDay(tx, session.shopId, date);
    if (later) throw new ConflictError("LATER_DAY_CLOSED", `A later day (${later}) is closed. Reopen that one first.`);
    // The short/extra journal is undone with a reversal (the original stays), so the next close posts what is true then.
    if (closing.differenceJournalId) await reverseJournal(tx, booksOf(session), { journalId: closing.differenceJournalId, entryDate: date, memo: "Day reopened" });
    await tx.update(dayClosings).set({ status: "reopened", reopenedBy: session.userId, reopenedAt: new Date(), reopenReason: reason }).where(eq(dayClosings.id, closing.id));
    await recordAudit(tx, actorOf(session), { action: "cashbook.day_reopened", entityType: "day_closing", entityId: date, before: { status: "closed", countedCashPaise: closing.countedCashPaise }, after: { status: "reopened" }, reason });
  });
}

// ── One cash figure: health, explicit reconciliation and drawer counts ───────────────────────────────

export type CashHealth = {
  /** "books": the posted Cash account is the cash figure. "cashbook": the shop has no Business Accounts yet, so nothing changes. */
  mode: "books" | "cashbook";
  bookCashPaise: number | null;
  needsReconciliation: boolean;
  /** Why the figures disagree (only when they do). */
  openingSettingPaise: number;
  openingInBooksPaise: number;
  unpostedDifferences: { businessDate: string; differencePaise: number }[];
  reconciledAt: Date | null;
};

/**
 * Whether the books' cash and the cashbook's history agree. They can disagree from before this feature: the opening cash typed
 * at setup differing from the opening in the books, or a closed day whose short/extra was never posted. Nothing is corrected
 * silently; the owner confirms the real cash once (`reconcileCash`), which posts the difference and is kept as a record.
 */
export async function cashHealthOf(db: Db, shopId: string): Promise<CashHealth> {
  const today = indiaDate();
  const basis = await cashBasisFor(db, shopId, today);
  const empty: CashHealth = { mode: "cashbook", bookCashPaise: null, needsReconciliation: false, openingSettingPaise: 0, openingInBooksPaise: 0, unpostedDifferences: [], reconciledAt: null };
  if (basis.mode !== "books") return empty;
  const [bookCashPaise, openingSettingPaise, openingInBooksPaise] = await Promise.all([bookCashOn(db, shopId, null), shopOpeningCash(shopId), openingCashInBooks(db, shopId)]);
  const unposted = await db
    .select({ businessDate: dayClosings.businessDate, differencePaise: dayClosings.differencePaise })
    .from(dayClosings)
    .where(and(eq(dayClosings.shopId, shopId), eq(dayClosings.status, "closed"), sql`${dayClosings.differencePaise} <> 0`, isNull(dayClosings.differenceJournalId), sql`${dayClosings.businessDate} >= ${basis.coverageStartDate}`))
    .orderBy(asc(dayClosings.businessDate));
  // A confirmation counts until it is undone: an undo is a later row that points at it.
  const confirmed = await db
    .select({ createdAt: cashReconciliations.createdAt })
    .from(cashReconciliations)
    .where(and(eq(cashReconciliations.shopId, shopId), eq(cashReconciliations.kind, "confirm"), sql`not exists (select 1 from cash_reconciliations r where r.reverses_id = ${cashReconciliations.id})`))
    .orderBy(desc(cashReconciliations.createdAt))
    .limit(1);
  const disagree = openingSettingPaise !== openingInBooksPaise || unposted.length > 0;
  return { mode: "books", bookCashPaise, needsReconciliation: disagree && confirmed.length === 0, openingSettingPaise, openingInBooksPaise, unpostedDifferences: unposted, reconciledAt: confirmed[0]?.createdAt ?? null };
}

export async function getCashHealth(session: SessionContext): Promise<CashHealth> {
  await requirePermission(session, CASH_VIEW);
  return cashHealthOf(getDb(), session.shopId);
}

const countedSchema = z.string().trim().transform((value, ctx) => {
  const paise = parseRupeesToPaise(value === "" ? "x" : value);
  if (paise === null) {
    ctx.addIssue({ code: "custom", message: "Enter the cash you counted, in rupees (0 if the drawer is empty)." });
    return z.NEVER;
  }
  return paise;
});

const reconcileSchema = z.object({
  idempotencyKey: key,
  counted: countedSchema,
  reason: z.string().trim().min(3, "Write a short reason (at least 3 characters).").max(200),
});

/**
 * The owner counts the drawer and confirms it: books cash is moved to the counted amount with one journal and a record
 * of who confirmed what. Nothing before it is rewritten. Undo it with `reverseCashReconciliation`.
 */
export async function reconcileCash(session: SessionContext, input: unknown): Promise<{ id: string; differencePaise: number; replayed: boolean }> {
  await requirePermission(session, CASH_RECONCILE);
  const { idempotencyKey, ...data } = reconcileSchema.parse(input);
  return withTransaction(async (tx) => {
    const outcome = await withIdempotency<{ id: string; differencePaise: number }>(tx, { shopId: session.shopId, userId: session.userId, key: idempotencyKey }, { action: "cashbook.reconcile", ...data }, async () => {
      const today = indiaDate();
      await lockDayForWrite(tx, session.shopId, today);
      if ((await cashBasisFor(tx, session.shopId, today)).mode !== "books") throw new ConflictError("NO_BOOKS", "Business Accounts are not on, so there is nothing to reconcile.");
      const bookCashPaise = await bookCashOn(tx, session.shopId, null);
      const differencePaise = data.counted - bookCashPaise;
      const [row] = await tx.insert(cashReconciliations).values({ shopId: session.shopId, kind: "confirm", asOfDate: today, bookCashPaise, countedPaise: data.counted, differencePaise, reason: data.reason, createdBy: session.userId }).returning({ id: cashReconciliations.id });
      if (differencePaise !== 0) {
        const posted = await postCashReconciled(tx, booksOf(session), { reconciliationId: row!.id, date: today, differencePaise });
        if (posted.status !== "posted") throw new ConflictError("NOT_POSTED", "The cash difference could not be added to your books.");
        await tx.update(cashReconciliations).set({ journalId: posted.journalId }).where(eq(cashReconciliations.id, row!.id));
      }
      await recordAudit(tx, actorOf(session), { action: "cashbook.cash_reconciled", entityType: "cash_reconciliation", entityId: row!.id, after: { bookCashPaise, countedPaise: data.counted, differencePaise }, reason: data.reason });
      return { status: 201, body: { id: row!.id, differencePaise } };
    });
    return { ...outcome.body, replayed: outcome.replayed };
  });
}

/** Undoes a confirmation: the journal is reversed and a reversal row is added. The original stays on record. */
export async function reverseCashReconciliation(session: SessionContext, reconciliationId: string, input: unknown): Promise<void> {
  await requirePermission(session, CASH_RECONCILE);
  const { reason } = reasonSchema.parse(input);
  await withTransaction(async (tx) => {
    const today = indiaDate();
    await lockDayForWrite(tx, session.shopId, today);
    const [original] = await tx.select().from(cashReconciliations).where(and(eq(cashReconciliations.id, reconciliationId), eq(cashReconciliations.shopId, session.shopId))).limit(1).for("update");
    if (!original || original.kind !== "confirm") throw new NotFoundError("Confirmation not found.");
    const [already] = await tx.select({ id: cashReconciliations.id }).from(cashReconciliations).where(eq(cashReconciliations.reversesId, original.id)).limit(1);
    if (already) throw new ConflictError("ALREADY_REVERSED", "This confirmation was already undone.");
    if (original.journalId) await reverseJournal(tx, booksOf(session), { journalId: original.journalId, entryDate: today, memo: "Cash confirmation undone" });
    const [row] = await tx.insert(cashReconciliations).values({ shopId: session.shopId, kind: "reversal", asOfDate: today, bookCashPaise: original.bookCashPaise, countedPaise: original.countedPaise, differencePaise: -original.differencePaise, reason, reversesId: original.id, createdBy: session.userId }).returning({ id: cashReconciliations.id });
    await recordAudit(tx, actorOf(session), { action: "cashbook.cash_reconciliation_reversed", entityType: "cash_reconciliation", entityId: row!.id, before: { reconciliationId: original.id, differencePaise: original.differencePaise }, reason });
  });
}

const drawerCountSchema = z.object({
  idempotencyKey: key,
  businessDate,
  counted: countedSchema,
  note: z.string().trim().max(200).optional().transform((value) => value || null),
});

/**
 * Whoever counted the drawer (a cashier, a manager or the owner) submits the amount. It is kept with their name; the person who
 * closes the day sees it. It never changes books by itself: only closing the day does.
 */
export async function submitDrawerCount(session: SessionContext, input: unknown): Promise<{ id: string; expectedPaise: number; differencePaise: number; replayed: boolean }> {
  await requirePermission(session, DRAWER_COUNT);
  const { idempotencyKey, ...data } = drawerCountSchema.parse(input);
  return withTransaction(async (tx) => {
    const outcome = await withIdempotency<{ id: string; expectedPaise: number; differencePaise: number }>(tx, { shopId: session.shopId, userId: session.userId, key: idempotencyKey }, { action: "cashbook.drawer_count", ...data }, async () => {
      const [closing] = await tx.select({ status: dayClosings.status }).from(dayClosings).where(and(eq(dayClosings.shopId, session.shopId), eq(dayClosings.businessDate, data.businessDate))).limit(1);
      if (closing?.status === "closed") throw new ConflictError("ALREADY_CLOSED", "This day is already closed.");
      const figures = await dayFigures(tx, session.shopId, data.businessDate);
      const [row] = await tx.insert(drawerCounts).values({ shopId: session.shopId, businessDate: data.businessDate, countedPaise: data.counted, note: data.note, countedBy: session.userId }).returning({ id: drawerCounts.id });
      const differencePaise = data.counted - figures.expectedPaise;
      await recordAudit(tx, actorOf(session), { action: "cashbook.drawer_counted", entityType: "drawer_count", entityId: row!.id, after: { businessDate: data.businessDate, countedPaise: data.counted, expectedPaise: figures.expectedPaise, differencePaise } });
      return { status: 201, body: { id: row!.id, expectedPaise: figures.expectedPaise, differencePaise } };
    });
    return { ...outcome.body, replayed: outcome.replayed };
  });
}

/** The latest counts submitted for a day, newest first, with who counted. */
export async function listDrawerCounts(db: Db, shopId: string, date: string, limit = 5) {
  const rows = await db.select().from(drawerCounts).where(and(eq(drawerCounts.shopId, shopId), eq(drawerCounts.businessDate, date))).orderBy(desc(drawerCounts.createdAt)).limit(limit);
  const names = await loadUserNames(shopId, [...new Set(rows.map((row) => row.countedBy))]);
  return rows.map((row) => ({ id: row.id, countedPaise: row.countedPaise, note: row.note, countedByName: names.get(row.countedBy) ?? "Unknown user", createdAt: row.createdAt }));
}
