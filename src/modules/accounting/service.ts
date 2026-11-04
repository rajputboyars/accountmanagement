import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/modules/audit";
import { requirePermission, type SessionContext } from "@/modules/identity";
import { getDb, withTransaction, type Database, type Transaction } from "@/server/db";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import {
  AccountingRuleError,
  assertBalanced,
  CHART,
  INPUT_GST_POLICIES,
  openingJournal,
  openingReclass,
  reversalEvent,
  type AccountKey,
  type JournalDraft,
} from "@/shared/accounting";
import { indiaDate } from "@/shared/financial-year";
import { accountingGaps, accounts, accountingSettings, journalLines, journals } from "./schema";

/**
 * Business Accounts (Phase 1a): the books, kept beside the customer and supplier ledgers. Opt-in per shop.
 * Other modules post through `postJournal` inside their own transaction, so a business event and its journal
 * commit or fail together. Nothing here changes inventory valuation or the party ledgers.
 */

/** Seeing the books is owner-only (same as profit); turning them on and confirming opening balances needs settings access. */
export const ACCOUNTING_VIEW = "profit.view" as const;
export const ACCOUNTING_MANAGE = "settings.edit" as const;

type Db = Database | Transaction;
const actorOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId, role: session.role });
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OPENING_SOURCE = "opening_balance";

const isRealDate = (value: string) => DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const dayBefore = (value: string) => new Date(new Date(`${value}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
const num = (value: unknown) => Number(value ?? 0);

/** Who is posting. Automatic postings made by the system (no signed-in user) pass `userId: null`. */
export type PostingContext = { shopId: string; userId: string | null };

export type PostResult =
  | { status: "posted"; journalId: string }
  | { status: "duplicate"; journalId: string }
  | { status: "skipped"; reason: "not_active" | "before_coverage" | "nothing_to_post" };

export async function loadAccountingSettings(db: Db, shopId: string) {
  const [row] = await db.select().from(accountingSettings).where(eq(accountingSettings.shopId, shopId)).limit(1);
  return row ?? null;
}

/** Creates the chart of accounts for a shop. Safe to repeat: existing accounts are left alone. */
export async function ensureChart(tx: Transaction, shopId: string): Promise<void> {
  await tx
    .insert(accounts)
    .values(CHART.map((account) => ({ shopId, systemKey: account.key, code: account.code, name: account.name, type: account.type, category: account.category, cashFlow: account.cashFlow })))
    .onConflictDoNothing();
}

async function accountIds(db: Db, shopId: string, keys: readonly string[]): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: accounts.id, key: accounts.systemKey })
    .from(accounts)
    .where(and(eq(accounts.shopId, shopId), inArray(accounts.systemKey, [...new Set(keys)])));
  return new Map(rows.map((row) => [row.key, row.id]));
}

const canonical = (lines: { account: string; debitPaise: number; creditPaise: number; partyType?: string | null; partyId?: string | null }[]) =>
  JSON.stringify(lines.map((line) => [line.account, line.debitPaise, line.creditPaise, line.partyType ?? null, line.partyId ?? null]).sort());

export type PostInput = {
  entryDate: string;
  sourceType: string;
  sourceId: string;
  draft: JournalDraft;
  memo?: string | null;
  kind?: "event" | "opening" | "adjustment";
};

/**
 * Post one balanced journal for a business event, inside the caller's transaction.
 * - Not activated, or dated before the books start: nothing is posted (the event is simply outside the books).
 * - Posting the same source and event again is a no-op, unless its amounts differ: then it is refused, because
 *   a changed document must be reversed and posted again, never overwritten.
 * - Missing costs are recorded as gaps so reports cannot look complete.
 */
export async function postJournal(tx: Transaction, ctx: PostingContext, input: PostInput): Promise<PostResult> {
  const settings = await loadAccountingSettings(tx, ctx.shopId);
  if (!settings) return { status: "skipped", reason: "not_active" };
  const kind = input.kind ?? "event";
  if (!isRealDate(input.entryDate)) throw new ValidationError("The journal date is not a valid date.");
  if (kind === "event" && input.entryDate < settings.coverageStartDate) return { status: "skipped", reason: "before_coverage" };
  if (settings.lockThrough && input.entryDate <= settings.lockThrough) throw new ConflictError("BOOKS_LOCKED", `The books are locked up to ${settings.lockThrough}.`);

  if (input.draft.gaps.length > 0) {
    await tx
      .insert(accountingGaps)
      .values(input.draft.gaps.map((gap) => ({ shopId: ctx.shopId, kind: gap.kind, sourceType: input.sourceType, sourceId: input.sourceId, ref: gap.ref, entryDate: input.entryDate, note: gap.note })))
      .onConflictDoNothing();
  }
  if (input.draft.lines.length === 0) return { status: "skipped", reason: "nothing_to_post" };

  try {
    assertBalanced(input.draft.lines);
  } catch (error) {
    if (error instanceof AccountingRuleError) throw new ValidationError(error.message);
    throw error;
  }
  const ids = await accountIds(tx, ctx.shopId, input.draft.lines.map((line) => line.account));
  const missing = input.draft.lines.find((line) => !ids.has(line.account));
  if (missing) throw new ConflictError("CHART_MISSING", `The account "${missing.account}" is not set up for this shop.`);

  const [created] = await tx
    .insert(journals)
    .values({ shopId: ctx.shopId, entryDate: input.entryDate, kind, sourceType: input.sourceType, sourceId: input.sourceId, event: input.draft.event, memo: input.memo ?? null, createdBy: ctx.userId })
    .onConflictDoNothing()
    .returning({ id: journals.id });
  if (!created) {
    const [existing] = await tx
      .select({ id: journals.id })
      .from(journals)
      .where(and(eq(journals.shopId, ctx.shopId), eq(journals.sourceType, input.sourceType), eq(journals.sourceId, input.sourceId), eq(journals.event, input.draft.event)))
      .limit(1);
    if (!existing) throw new ConflictError("JOURNAL_CONFLICT", "This entry could not be posted. Try again.");
    const rows = await tx
      .select({ key: accounts.systemKey, debitPaise: journalLines.debitPaise, creditPaise: journalLines.creditPaise, partyType: journalLines.partyType, partyId: journalLines.partyId })
      .from(journalLines)
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(eq(journalLines.journalId, existing.id));
    const same =
      canonical(rows.map((row) => ({ account: row.key, ...row }))) ===
      canonical(input.draft.lines.map((line) => ({ account: line.account, debitPaise: line.debitPaise, creditPaise: line.creditPaise, partyType: line.party?.type, partyId: line.party?.id })));
    if (!same) throw new ConflictError("JOURNAL_SOURCE_CHANGED", "This document was already posted with different amounts. Reverse it and post it again.");
    return { status: "duplicate", journalId: existing.id };
  }
  await tx.insert(journalLines).values(
    input.draft.lines.map((line) => ({
      journalId: created.id,
      shopId: ctx.shopId,
      accountId: ids.get(line.account)!,
      debitPaise: line.debitPaise,
      creditPaise: line.creditPaise,
      partyType: line.party?.type ?? null,
      partyId: line.party?.id ?? null,
    })),
  );
  return { status: "posted", journalId: created.id };
}

/**
 * Undo a posted journal by posting its mirror image. The original is never touched. Reversing twice is a no-op,
 * and a reversal cannot itself be reversed (post the corrected entry instead).
 */
export async function reverseJournal(tx: Transaction, ctx: PostingContext, input: { journalId: string; entryDate: string; memo?: string | null }): Promise<PostResult> {
  const settings = await loadAccountingSettings(tx, ctx.shopId);
  if (!settings) return { status: "skipped", reason: "not_active" };
  const [original] = await tx
    .select()
    .from(journals)
    .where(and(eq(journals.id, input.journalId), eq(journals.shopId, ctx.shopId)))
    .limit(1);
  if (!original) throw new NotFoundError("Journal not found.");
  if (original.kind === "reversal" || original.kind === "opening") throw new ValidationError("This journal cannot be reversed. Post a correcting entry instead.");
  if (!isRealDate(input.entryDate)) throw new ValidationError("The reversal date is not a valid date.");
  const [already] = await tx.select({ id: journals.id }).from(journals).where(eq(journals.reversesJournalId, original.id)).limit(1);
  if (already) return { status: "duplicate", journalId: already.id };
  if (settings.lockThrough && input.entryDate <= settings.lockThrough) throw new ConflictError("BOOKS_LOCKED", `The books are locked up to ${settings.lockThrough}.`);

  const lines = await tx.select().from(journalLines).where(eq(journalLines.journalId, original.id));
  const [created] = await tx
    .insert(journals)
    .values({ shopId: ctx.shopId, entryDate: input.entryDate, kind: "reversal", sourceType: original.sourceType, sourceId: original.sourceId, event: reversalEvent(original.event), memo: input.memo ?? null, reversesJournalId: original.id, createdBy: ctx.userId })
    .returning({ id: journals.id });
  await tx.insert(journalLines).values(
    lines.map((line) => ({
      journalId: created!.id,
      shopId: ctx.shopId,
      accountId: line.accountId,
      debitPaise: line.creditPaise,
      creditPaise: line.debitPaise,
      partyType: line.partyType,
      partyId: line.partyId,
    })),
  );
  return { status: "posted", journalId: created!.id };
}

const startDateSchema = z.object({ coverageStartDate: z.string().refine(isRealDate, "Choose a valid date.") });

/** Turn Business Accounts on. Books cover this date onward; nothing earlier is ever posted. Opening balances are entered next. */
export async function activateBusinessAccounts(session: SessionContext, input: unknown): Promise<{ coverageStartDate: string }> {
  await requirePermission(session, ACCOUNTING_MANAGE);
  const data = startDateSchema.parse(input);
  if (data.coverageStartDate > indiaDate()) throw new ValidationError("The books cannot start in the future.");
  return withTransaction(async (tx) => {
    if (await loadAccountingSettings(tx, session.shopId)) throw new ConflictError("ACCOUNTING_ACTIVE", "Business Accounts are already on.");
    await tx.insert(accountingSettings).values({ shopId: session.shopId, coverageStartDate: data.coverageStartDate, activatedBy: session.userId });
    await ensureChart(tx, session.shopId);
    await recordAudit(tx, actorOf(session), { action: "accounting.activated", entityType: "shop", entityId: session.shopId, after: { coverageStartDate: data.coverageStartDate } });
    return { coverageStartDate: data.coverageStartDate };
  });
}

/** Where input GST is posted from now on. Earlier journals are not changed. "review" decides nothing; the other two are explicit choices for the shop's CA to confirm. */
export async function setInputGstPolicy(session: SessionContext, policy: unknown): Promise<void> {
  await requirePermission(session, ACCOUNTING_MANAGE);
  const value = z.enum(INPUT_GST_POLICIES).parse(policy);
  await withTransaction(async (tx) => {
    const settings = await loadAccountingSettings(tx, session.shopId);
    if (!settings) throw new ConflictError("ACCOUNTING_OFF", "Turn on Business Accounts first.");
    await tx.update(accountingSettings).set({ inputGstPolicy: value }).where(eq(accountingSettings.shopId, session.shopId));
    await recordAudit(tx, actorOf(session), { action: "accounting.input_gst_policy_changed", entityType: "shop", entityId: session.shopId, before: { inputGstPolicy: settings.inputGstPolicy }, after: { inputGstPolicy: value } });
  });
}

const paiseInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const balance = z.object({ partyId: z.string().uuid(), balancePaise: z.number().int() });
const openingSchema = z.object({
  receivables: z.array(balance).max(5000),
  payables: z.array(balance).max(5000),
  inventoryPaise: paiseInt,
  cashPaise: paiseInt,
  bankPaise: paiseInt,
  upiPaise: paiseInt,
  cardPaise: paiseInt,
  chequesPaise: paiseInt,
  other: z.array(z.object({ account: z.string(), side: z.enum(["debit", "credit"]), amountPaise: paiseInt })).max(50),
  unvaluedProductIds: z.array(z.string().uuid()).max(5000),
});

/**
 * Post the opening balances as at the close of the day before the books start. Whatever does not balance goes to the
 * "opening balance clearing" account, not to owner's capital, until the owner confirms it (confirmOpeningBalances).
 * Figures are supplied by the server-side derivation (Phase 1b) or entered by the owner; parties must belong to this shop.
 */
export async function recordOpeningBalances(session: SessionContext, input: unknown): Promise<{ journalId: string; clearingBalancePaise: number }> {
  await requirePermission(session, ACCOUNTING_MANAGE);
  const data = openingSchema.parse(input);
  return withTransaction(async (tx) => {
    const settings = await loadAccountingSettings(tx, session.shopId);
    if (!settings) throw new ConflictError("ACCOUNTING_OFF", "Turn on Business Accounts first.");
    const [existing] = await tx.select({ id: journals.id }).from(journals).where(and(eq(journals.shopId, session.shopId), eq(journals.sourceType, OPENING_SOURCE), eq(journals.kind, "opening"))).limit(1);
    if (existing) throw new ConflictError("OPENING_ALREADY_RECORDED", "Opening balances were already recorded. Correct them with a dated adjustment instead.");
    await assertPartiesBelong(tx, session.shopId, "customers", data.receivables.map((row) => row.partyId));
    await assertPartiesBelong(tx, session.shopId, "suppliers", data.payables.map((row) => row.partyId));
    let draft: JournalDraft;
    try {
      draft = openingJournal({ ...data, other: data.other.map((row) => ({ ...row, account: row.account as AccountKey })) });
    } catch (error) {
      if (error instanceof AccountingRuleError) throw new ValidationError(error.message);
      throw error;
    }
    const result = await postJournal(tx, { shopId: session.shopId, userId: session.userId }, { entryDate: dayBefore(settings.coverageStartDate), sourceType: OPENING_SOURCE, sourceId: session.shopId, draft, kind: "opening", memo: "Opening balances" });
    if (result.status === "duplicate") throw new ConflictError("OPENING_ALREADY_RECORDED", "Opening balances were already recorded. Correct them with a dated adjustment instead.");
    if (result.status !== "posted") throw new ConflictError("OPENING_NOT_POSTED", "Opening balances could not be posted.");
    const clearing = await clearingBalance(tx, session.shopId);
    await recordAudit(tx, actorOf(session), { action: "accounting.opening_recorded", entityType: "journal", entityId: result.journalId, after: { clearingBalancePaise: clearing, unvaluedProducts: data.unvaluedProductIds.length } });
    return { journalId: result.journalId, clearingBalancePaise: clearing };
  });
}

async function assertPartiesBelong(tx: Transaction, shopId: string, table: "customers" | "suppliers", ids: string[]) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const found = await tx.execute<{ n: string }>(sql`select count(*) as n from ${sql.identifier(table)} where shop_id = ${shopId} and id in (${sql.join(unique.map((value) => sql`${value}`), sql`, `)})`);
  if (num(found.rows[0]?.n) !== unique.length) throw new ValidationError("Some customers or suppliers in the opening balances do not belong to this business.");
}

/** Debit minus credit on the clearing account: positive means money is still waiting to be assigned. */
async function clearingBalance(db: Db, shopId: string): Promise<number> {
  const result = await db.execute<{ balance: string }>(sql`
    select coalesce(sum(l.debit_paise - l.credit_paise), 0) as balance
    from journal_lines l join accounts a on a.id = l.account_id
    where l.shop_id = ${shopId} and a.system_key = 'opening_clearing'`);
  return num(result.rows[0]?.balance);
}

/**
 * The owner's explicit confirmation of the opening balances: any amount still in clearing is moved to owner's capital
 * and the opening is marked verified. Until then reports say the opening balances are unverified.
 */
export async function confirmOpeningBalances(session: SessionContext): Promise<{ movedToCapitalPaise: number }> {
  await requirePermission(session, ACCOUNTING_MANAGE);
  return withTransaction(async (tx) => {
    const settings = await loadAccountingSettings(tx, session.shopId);
    if (!settings) throw new ConflictError("ACCOUNTING_OFF", "Turn on Business Accounts first.");
    const [opening] = await tx.select({ id: journals.id }).from(journals).where(and(eq(journals.shopId, session.shopId), eq(journals.sourceType, OPENING_SOURCE), eq(journals.kind, "opening"))).limit(1);
    if (!opening) throw new ConflictError("OPENING_MISSING", "Enter the opening balances first.");
    if (settings.openingStatus === "verified") return { movedToCapitalPaise: 0 };
    const clearing = await clearingBalance(tx, session.shopId);
    if (clearing !== 0) {
      const result = await postJournal(tx, { shopId: session.shopId, userId: session.userId }, { entryDate: settings.coverageStartDate, sourceType: OPENING_SOURCE, sourceId: session.shopId, draft: openingReclass(clearing), kind: "adjustment", memo: "Opening balance confirmed by owner" });
      if (result.status !== "posted") throw new ConflictError("OPENING_NOT_CONFIRMED", "The opening balances could not be confirmed. Try again.");
    }
    await tx.update(accountingSettings).set({ openingStatus: "verified" }).where(eq(accountingSettings.shopId, session.shopId));
    await recordAudit(tx, actorOf(session), { action: "accounting.opening_confirmed", entityType: "shop", entityId: session.shopId, before: { clearingBalancePaise: clearing }, after: { openingStatus: "verified" } });
    return { movedToCapitalPaise: Math.abs(clearing) };
  });
}

export type AccountingStatus = {
  active: boolean;
  coverageStartDate: string | null;
  openingRecorded: boolean;
  openingStatus: "unverified" | "verified" | null;
  inputGstPolicy: (typeof INPUT_GST_POLICIES)[number] | null;
  lockThrough: string | null;
  clearingBalancePaise: number;
  openGaps: { kind: string; count: number }[];
  /** True only when nothing is unverified or missing. Reports must not look complete otherwise. */
  complete: boolean;
  /** Why the books are not complete, as stable codes the screens translate. */
  incompleteReasons: ("not_active" | "opening_missing" | "opening_unverified" | "clearing_not_zero" | "gaps_open" | "input_gst_review")[];
};

export async function getAccountingStatus(session: SessionContext): Promise<AccountingStatus> {
  await requirePermission(session, ACCOUNTING_VIEW);
  const db = getDb();
  const settings = await loadAccountingSettings(db, session.shopId);
  if (!settings) return { active: false, coverageStartDate: null, openingRecorded: false, openingStatus: null, inputGstPolicy: null, lockThrough: null, clearingBalancePaise: 0, openGaps: [], complete: false, incompleteReasons: ["not_active"] };
  const [opening] = await db.select({ id: journals.id }).from(journals).where(and(eq(journals.shopId, session.shopId), eq(journals.sourceType, OPENING_SOURCE), eq(journals.kind, "opening"))).limit(1);
  const gaps = await db.execute<{ kind: string; n: string }>(sql`select kind, count(*) as n from accounting_gaps where shop_id = ${session.shopId} and resolved_at is null group by kind order by kind`);
  const clearing = await clearingBalance(db, session.shopId);
  const reasons: AccountingStatus["incompleteReasons"] = [];
  if (!opening) reasons.push("opening_missing");
  else if (settings.openingStatus !== "verified") reasons.push("opening_unverified");
  if (clearing !== 0) reasons.push("clearing_not_zero");
  if (gaps.rows.length > 0) reasons.push("gaps_open");
  if (settings.inputGstPolicy === "review") reasons.push("input_gst_review");
  return {
    active: true,
    coverageStartDate: settings.coverageStartDate,
    openingRecorded: Boolean(opening),
    openingStatus: settings.openingStatus,
    inputGstPolicy: settings.inputGstPolicy,
    lockThrough: settings.lockThrough,
    clearingBalancePaise: clearing,
    openGaps: gaps.rows.map((row) => ({ kind: row.kind, count: num(row.n) })),
    complete: reasons.length === 0,
    incompleteReasons: reasons,
  };
}

export type AccountBalanceRow = { systemKey: string; code: string; name: string; type: string; debitPaise: number; creditPaise: number };

/** Debit and credit totals per account for a date range (inclusive). The basis of the trial balance. */
export async function accountBalances(session: SessionContext, range: { from?: string; to?: string } = {}): Promise<AccountBalanceRow[]> {
  await requirePermission(session, ACCOUNTING_VIEW);
  for (const value of [range.from, range.to]) if (value !== undefined && !isRealDate(value)) throw new ValidationError("Choose a valid date.");
  const from = range.from ?? "0001-01-01";
  const to = range.to ?? "9999-12-31";
  const result = await getDb().execute<{ system_key: string; code: string; name: string; type: string; debit: string; credit: string }>(sql`
    select a.system_key, a.code, a.name, a.type,
           coalesce(sum(l.debit_paise), 0) as debit, coalesce(sum(l.credit_paise), 0) as credit
    from accounts a
    left join (
      select l.account_id, l.debit_paise, l.credit_paise
      from journal_lines l join journals j on j.id = l.journal_id
      where j.shop_id = ${session.shopId} and j.entry_date between ${from} and ${to}
    ) l on l.account_id = a.id
    where a.shop_id = ${session.shopId}
    group by a.id order by a.code`);
  return result.rows.map((row) => ({ systemKey: row.system_key, code: row.code, name: row.name, type: row.type, debitPaise: num(row.debit), creditPaise: num(row.credit) }));
}
