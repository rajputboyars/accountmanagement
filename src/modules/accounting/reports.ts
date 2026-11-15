import { sql } from "drizzle-orm";
import { requirePermission, type SessionContext } from "@/modules/identity";
import { getDb, type Database, type Transaction } from "@/server/db";
import { ValidationError } from "@/server/errors";
import { isCashLikeKey } from "@/shared/accounting";
import { indiaDate } from "@/shared/financial-year";
import { reconcileParties, stockValueComparison } from "./reconcile";
import { ACCOUNTING_VIEW, getAccountingStatus, type AccountingStatus } from "./service";

/**
 * Reports for the owner and the optional Accountant View, worked out only from posted journals. They are internal
 * management reports, not certified statements. Each carries a completeness verdict so a figure that rests on missing
 * costs, unverified opening balances or books that start after the period is never presented as complete.
 */

type Db = Database | Transaction;
const num = (value: unknown) => Number(value ?? 0);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (value: string) => DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const checkDate = (value: string, label: string) => {
  if (!isRealDate(value)) throw new ValidationError(`Choose a valid ${label} date.`);
  return value;
};

export type ReportReason = "not_active" | "before_coverage" | "gaps_in_period" | "opening_missing" | "opening_unverified" | "clearing_not_zero" | "gaps_open" | "party_mismatch" | "input_gst_review" | "cash_unclassified";
export type Completeness = { complete: boolean; reasons: ReportReason[]; coverageStartDate: string | null };
export type Row = { key: string; code: string; name: string; amountPaise: number };

type Balance = { key: string; code: string; name: string; type: string; category: string; debitPaise: number; creditPaise: number };

async function balancesWithin(db: Db, shopId: string, from: string | null, to: string): Promise<Balance[]> {
  const result = await db.execute<{ system_key: string; code: string; name: string; type: string; category: string; debit: string; credit: string }>(sql`
    select a.system_key, a.code, a.name, a.type, a.category,
           coalesce(sum(l.debit_paise), 0) as debit, coalesce(sum(l.credit_paise), 0) as credit
    from accounts a
    left join (
      select l.account_id, l.debit_paise, l.credit_paise from journal_lines l join journals j on j.id = l.journal_id
      where j.shop_id = ${shopId} and j.entry_date <= ${to} and (${from}::date is null or j.entry_date >= ${from}::date)
    ) l on l.account_id = a.id
    where a.shop_id = ${shopId} group by a.id order by a.code`);
  return result.rows.map((row) => ({ key: row.system_key, code: row.code, name: row.name, type: row.type, category: row.category, debitPaise: num(row.debit), creditPaise: num(row.credit) }));
}

const debitNet = (b: Balance) => b.debitPaise - b.creditPaise;
const creditNet = (b: Balance) => b.creditPaise - b.debitPaise;
const rowOf = (b: Balance, amountPaise: number): Row => ({ key: b.key, code: b.code, name: b.name, amountPaise });

async function periodGaps(db: Db, shopId: string, from: string, to: string): Promise<number> {
  const result = await db.execute<{ n: string }>(sql`select count(*) as n from accounting_gaps where shop_id = ${shopId} and resolved_at is null and entry_date between ${from} and ${to}`);
  return num(result.rows[0]?.n);
}

async function completeness(session: SessionContext, db: Db, input: { from: string | null; to: string; scope: "period" | "position" | "cash" }): Promise<{ completeness: Completeness; status: AccountingStatus }> {
  const status = await getAccountingStatus(session);
  if (!status.active) return { status, completeness: { complete: false, reasons: ["not_active"], coverageStartDate: null } };
  const reasons: ReportReason[] = [];
  const start = status.coverageStartDate!;
  if (input.scope === "period") {
    if (input.from !== null && input.from < start) reasons.push("before_coverage");
    if ((await periodGaps(db, session.shopId, input.from ?? start, input.to)) > 0) reasons.push("gaps_in_period");
    if (status.incompleteReasons.includes("input_gst_review") && (await reviewGstBalance(db, session.shopId)) !== 0) reasons.push("input_gst_review");
  } else {
    if (input.to < start) reasons.push("before_coverage");
    for (const reason of status.incompleteReasons) {
      if (reason === "input_gst_review") {
        if ((await reviewGstBalance(db, session.shopId)) !== 0) reasons.push(reason);
      } else if (reason !== "not_active") reasons.push(reason);
    }
    if (input.scope === "cash" && input.from !== null && input.from < start) reasons.push("before_coverage");
  }
  const unique = [...new Set(reasons)];
  return { status, completeness: { complete: unique.length === 0, reasons: unique, coverageStartDate: start } };
}

async function reviewGstBalance(db: Db, shopId: string): Promise<number> {
  const result = await db.execute<{ amount: string }>(sql`select coalesce(sum(l.debit_paise - l.credit_paise), 0) as amount from journal_lines l join accounts a on a.id = l.account_id where l.shop_id = ${shopId} and a.system_key = 'gst_input_review'`);
  return num(result.rows[0]?.amount);
}

export type ProfitAndLoss = {
  from: string;
  to: string;
  completeness: Completeness;
  sales: Row[];
  netSalesPaise: number;
  costOfGoods: Row[];
  costOfGoodsPaise: number;
  grossProfitPaise: number;
  otherIncome: Row[];
  expenses: Row[];
  expensesPaise: number;
  netProfitPaise: number;
};

/** Gross profit = net sales minus cost of goods sold; net profit = gross profit plus other income minus expenses and stock losses. */
export async function profitAndLoss(session: SessionContext, range: { from: string; to: string }): Promise<ProfitAndLoss> {
  await requirePermission(session, ACCOUNTING_VIEW);
  const from = checkDate(range.from, "start");
  const to = checkDate(range.to, "end");
  const db = getDb();
  const balances = await balancesWithin(db, session.shopId, from, to);
  const pick = (keys: string[], side: "credit" | "debit") => balances.filter((b) => keys.includes(b.key)).map((b) => rowOf(b, side === "credit" ? creditNet(b) : debitNet(b)));
  // Returns are a debit balance, so their credit-side amount is negative and reduces net sales.
  const sales = pick(["sales", "sales_returns"], "credit");
  const netSalesPaise = sales.reduce((sum, row) => sum + row.amountPaise, 0);
  const costOfGoods = pick(["cogs"], "debit");
  const costOfGoodsPaise = costOfGoods.reduce((sum, row) => sum + row.amountPaise, 0);
  const otherIncome = pick(["stock_gain", "round_off"], "credit");
  const expenses = balances.filter((b) => b.type === "expense" && b.key !== "cogs").map((b) => rowOf(b, debitNet(b))).filter((row) => row.amountPaise !== 0);
  const expensesPaise = expenses.reduce((sum, row) => sum + row.amountPaise, 0);
  const grossProfitPaise = netSalesPaise - costOfGoodsPaise;
  const { completeness: verdict } = await completeness(session, db, { from, to, scope: "period" });
  return { from, to, completeness: verdict, sales, netSalesPaise, costOfGoods, costOfGoodsPaise, grossProfitPaise, otherIncome, expenses, expensesPaise, netProfitPaise: grossProfitPaise + otherIncome.reduce((sum, row) => sum + row.amountPaise, 0) - expensesPaise };
}

export type TrialBalance = { asOf: string; completeness: Completeness; rows: { key: string; code: string; name: string; type: string; debitPaise: number; creditPaise: number }[]; totalDebitPaise: number; totalCreditPaise: number; balanced: boolean };

/** Every account's closing balance (all journals up to the date, including opening balances). Debits always equal credits. */
export async function trialBalance(session: SessionContext, asOf: string): Promise<TrialBalance> {
  await requirePermission(session, ACCOUNTING_VIEW);
  checkDate(asOf, "as-at");
  const db = getDb();
  const balances = await balancesWithin(db, session.shopId, null, asOf);
  const rows = balances
    .map((b) => ({ key: b.key, code: b.code, name: b.name, type: b.type, debitPaise: Math.max(debitNet(b), 0), creditPaise: Math.max(-debitNet(b), 0) }))
    .filter((row) => row.debitPaise !== 0 || row.creditPaise !== 0);
  const totalDebitPaise = rows.reduce((sum, row) => sum + row.debitPaise, 0);
  const totalCreditPaise = rows.reduce((sum, row) => sum + row.creditPaise, 0);
  const { completeness: verdict } = await completeness(session, db, { from: null, to: asOf, scope: "position" });
  return { asOf, completeness: verdict, rows, totalDebitPaise, totalCreditPaise, balanced: totalDebitPaise === totalCreditPaise };
}

export type BalanceSheet = {
  asOf: string;
  completeness: Completeness;
  assets: Row[];
  totalAssetsPaise: number;
  liabilities: Row[];
  totalLiabilitiesPaise: number;
  equity: Row[];
  /** Profit earned since the books started that has not been moved to owner's capital. */
  earningsPaise: number;
  totalEquityPaise: number;
  balanced: boolean;
  stockValue: { booksPaise: number; atCostPaise: number; unvaluedProducts: number };
};

export async function balanceSheet(session: SessionContext, asOf: string): Promise<BalanceSheet> {
  await requirePermission(session, ACCOUNTING_VIEW);
  checkDate(asOf, "as-at");
  const db = getDb();
  const balances = await balancesWithin(db, session.shopId, null, asOf);
  const side = (type: string, net: (b: Balance) => number) => balances.filter((b) => b.type === type && net(b) !== 0).map((b) => rowOf(b, net(b)));
  const assets = side("asset", debitNet);
  const liabilities = side("liability", creditNet);
  const equity = side("equity", creditNet);
  const earningsPaise = balances.filter((b) => b.type === "income").reduce((sum, b) => sum + creditNet(b), 0) - balances.filter((b) => b.type === "expense").reduce((sum, b) => sum + debitNet(b), 0);
  const total = (rows: Row[]) => rows.reduce((sum, row) => sum + row.amountPaise, 0);
  const totalAssetsPaise = total(assets);
  const totalLiabilitiesPaise = total(liabilities);
  const totalEquityPaise = total(equity) + earningsPaise;
  const { completeness: verdict } = await completeness(session, db, { from: null, to: asOf, scope: "position" });
  return { asOf, completeness: verdict, assets, totalAssetsPaise, liabilities, totalLiabilitiesPaise, equity, earningsPaise, totalEquityPaise, balanced: totalAssetsPaise === totalLiabilitiesPaise + totalEquityPaise, stockValue: await stockValueComparison(db, session.shopId) };
}

export type CashFlowStatement = {
  from: string;
  to: string;
  completeness: Completeness;
  openingCashPaise: number;
  closingCashPaise: number;
  netChangePaise: number;
  operatingPaise: number;
  investingPaise: number;
  financingPaise: number;
  unclassifiedPaise: number;
  /** Where each class of cash came from or went, by the account on the other side of the cash journal. */
  details: { key: string; name: string; cashFlow: string; amountPaise: number }[];
  /** Opening plus net change equals closing. False would mean a journal is missing a side. */
  reconciles: boolean;
  /** Cash and cash-like balances (cash, bank, UPI, card, cheques) at the end of the period. */
  accounts: Row[];
};

/**
 * Direct-method cash flow from the journals that touch a cash account, classified by the account on the other side
 * (see cashFlowOf in src/shared/accounting.ts). Moves between cash accounts, such as a bank deposit, are not cash flow.
 */
export async function cashFlow(session: SessionContext, range: { from: string; to: string }): Promise<CashFlowStatement> {
  await requirePermission(session, ACCOUNTING_VIEW);
  const from = checkDate(range.from, "start");
  const to = checkDate(range.to, "end");
  const db = getDb();
  const lines = await db.execute<{ system_key: string; name: string; cash_flow: string; amount: string }>(sql`
    select a.system_key, a.name, a.cash_flow, sum(l.credit_paise - l.debit_paise) as amount
    from journal_lines l
    join journals j on j.id = l.journal_id
    join accounts a on a.id = l.account_id
    where j.shop_id = ${session.shopId} and j.entry_date between ${from} and ${to} and a.cash_flow <> 'cash'
      and exists (select 1 from journal_lines c join accounts ca on ca.id = c.account_id where c.journal_id = j.id and ca.cash_flow = 'cash')
    group by a.system_key, a.name, a.cash_flow having sum(l.credit_paise - l.debit_paise) <> 0 order by a.system_key`);
  const details = lines.rows.map((row) => ({ key: row.system_key, name: row.name, cashFlow: row.cash_flow, amountPaise: num(row.amount) }));
  const bucket = (cls: string) => details.filter((row) => row.cashFlow === cls).reduce((sum, row) => sum + row.amountPaise, 0);
  const cashBefore = await balancesWithin(db, session.shopId, null, new Date(new Date(`${from}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10));
  const cashAtEnd = await balancesWithin(db, session.shopId, null, to);
  const cashAccounts = (balances: Balance[]) => balances.filter((b) => isCashLikeKey(b.key));
  const openingCashPaise = cashAccounts(cashBefore).reduce((sum, b) => sum + debitNet(b), 0);
  const closingCashPaise = cashAccounts(cashAtEnd).reduce((sum, b) => sum + debitNet(b), 0);
  const operatingPaise = bucket("operating");
  const investingPaise = bucket("investing");
  const financingPaise = bucket("financing");
  const unclassifiedPaise = bucket("none");
  const netChangePaise = operatingPaise + investingPaise + financingPaise + unclassifiedPaise;
  const { completeness: verdict } = await completeness(session, db, { from, to, scope: "cash" });
  if (unclassifiedPaise !== 0) verdict.reasons.push("cash_unclassified");
  verdict.complete = verdict.reasons.length === 0;
  return { from, to, completeness: verdict, openingCashPaise, closingCashPaise, netChangePaise, operatingPaise, investingPaise, financingPaise, unclassifiedPaise, details, reconciles: openingCashPaise + netChangePaise === closingCashPaise, accounts: cashAccounts(cashAtEnd).map((b) => rowOf(b, debitNet(b))) };
}

/** Where a journal came from, as a page the person can open. Payments go to the customer's or supplier's statement. */
export function sourceHref(sourceType: string, sourceId: string, party: { type: string | null; id: string | null } = { type: null, id: null }): string | null {
  switch (sourceType) {
    case "invoice":
      return `/billing/invoices/${sourceId}`;
    case "credit_note":
      return `/billing/returns/${sourceId}`;
    case "goods_receipt":
      return `/purchases/receipts/${sourceId}`;
    case "payment":
      return party.type === "customer" && party.id ? `/customers/${party.id}/statement` : party.type === "supplier" && party.id ? `/suppliers/${party.id}/statement` : "/cashbook";
    case "expense":
    case "cash_movement":
      return "/cashbook";
    case "stock_adjustment":
      return "/inventory/stock";
    case "opening_stock":
      return "/inventory/stock";
    case "opening_balance":
      return "/reports/money/setup";
    case "bank_match_group":
    case "bank_opening":
      return "/reports/money/bank";
    default:
      return null;
  }
}

export type LedgerLine = { journalId: string; seq: number; entryDate: string; event: string; kind: string; sourceType: string; sourceId: string; memo: string | null; debitPaise: number; creditPaise: number; balancePaise: number; href: string | null };
export type AccountLedger = { account: { key: string; code: string; name: string; type: string } | null; from: string; to: string; openingBalancePaise: number; lines: LedgerLine[]; truncated: boolean };
export const LEDGER_ROWS = 200;

/** One account's lines with a running balance (debit minus credit) and a link to the document behind each. */
export async function accountLedger(session: SessionContext, input: { account: string; from: string; to: string }): Promise<AccountLedger> {
  await requirePermission(session, ACCOUNTING_VIEW);
  const from = checkDate(input.from, "start");
  const to = checkDate(input.to, "end");
  const db = getDb();
  const [account] = (await db.execute<{ id: string; system_key: string; code: string; name: string; type: string }>(sql`select id, system_key, code, name, type from accounts where shop_id = ${session.shopId} and system_key = ${input.account}`)).rows;
  if (!account) return { account: null, from, to, openingBalancePaise: 0, lines: [], truncated: false };
  const rows = await db.execute<{ journal_id: string; seq: string; entry_date: string; event: string; kind: string; source_type: string; source_id: string; memo: string | null; debit: string; credit: string; party_type: string | null; party_id: string | null; running: string }>(sql`
    select * from (
      select j.id as journal_id, j.seq, j.entry_date::text as entry_date, j.event, j.kind, j.source_type, j.source_id, j.memo,
             l.debit_paise as debit, l.credit_paise as credit, l.party_type, l.party_id,
             sum(l.debit_paise - l.credit_paise) over (order by j.entry_date, j.seq, l.id) as running
      from journal_lines l join journals j on j.id = l.journal_id
      where l.account_id = ${account.id} and l.shop_id = ${session.shopId}
    ) x where x.entry_date between ${from} and ${to} order by x.entry_date, x.seq limit ${LEDGER_ROWS + 1}`);
  const opening = await db.execute<{ amount: string }>(sql`
    select coalesce(sum(l.debit_paise - l.credit_paise), 0) as amount from journal_lines l join journals j on j.id = l.journal_id
    where l.account_id = ${account.id} and l.shop_id = ${session.shopId} and j.entry_date < ${from}`);
  const lines = rows.rows.slice(0, LEDGER_ROWS).map((row) => ({
    journalId: row.journal_id,
    seq: num(row.seq),
    entryDate: row.entry_date,
    event: row.event,
    kind: row.kind,
    sourceType: row.source_type,
    sourceId: row.source_id,
    memo: row.memo,
    debitPaise: num(row.debit),
    creditPaise: num(row.credit),
    balancePaise: num(row.running),
    href: sourceHref(row.source_type, row.source_id, { type: row.party_type, id: row.party_id }),
  }));
  return { account: { key: account.system_key, code: account.code, name: account.name, type: account.type }, from, to, openingBalancePaise: num(opening.rows[0]?.amount), lines, truncated: rows.rows.length > LEDGER_ROWS };
}

export type JournalView = { id: string; seq: number; entryDate: string; event: string; kind: string; memo: string | null; reversesJournalId: string | null; href: string | null; lines: { account: string; code: string; debitPaise: number; creditPaise: number }[] };
export const JOURNAL_ROWS = 50;

/** The journals themselves, newest first, for the Accountant View. */
export async function listJournals(session: SessionContext, input: { from: string; to: string; page?: number }): Promise<{ journals: JournalView[]; hasMore: boolean }> {
  await requirePermission(session, ACCOUNTING_VIEW);
  const from = checkDate(input.from, "start");
  const to = checkDate(input.to, "end");
  const offset = Math.max((input.page ?? 1) - 1, 0) * JOURNAL_ROWS;
  const db = getDb();
  const heads = await db.execute<{ id: string; seq: string; entry_date: string; event: string; kind: string; memo: string | null; reverses: string | null; source_type: string; source_id: string }>(sql`
    select id, seq, entry_date::text as entry_date, event, kind, memo, reverses_journal_id as reverses, source_type, source_id from journals
    where shop_id = ${session.shopId} and entry_date between ${from} and ${to} order by entry_date desc, seq desc limit ${JOURNAL_ROWS + 1} offset ${offset}`);
  const page = heads.rows.slice(0, JOURNAL_ROWS);
  if (page.length === 0) return { journals: [], hasMore: false };
  const lines = await db.execute<{ journal_id: string; code: string; name: string; debit: string; credit: string; party_type: string | null; party_id: string | null }>(sql`
    select l.journal_id, a.code, a.name, l.debit_paise as debit, l.credit_paise as credit, l.party_type, l.party_id
    from journal_lines l join accounts a on a.id = l.account_id
    where l.shop_id = ${session.shopId} and l.journal_id in (${sql.join(page.map((row) => sql`${row.id}`), sql`, `)}) order by l.id`);
  return {
    hasMore: heads.rows.length > JOURNAL_ROWS,
    journals: page.map((head) => {
      const own = lines.rows.filter((line) => line.journal_id === head.id);
      const party = own.find((line) => line.party_id);
      return { id: head.id, seq: num(head.seq), entryDate: head.entry_date, event: head.event, kind: head.kind, memo: head.memo, reversesJournalId: head.reverses, href: sourceHref(head.source_type, head.source_id, { type: party?.party_type ?? null, id: party?.party_id ?? null }), lines: own.map((line) => ({ account: line.name, code: line.code, debitPaise: num(line.debit), creditPaise: num(line.credit) })) };
    }),
  };
}

export type MoneyOverview = {
  active: boolean;
  status: AccountingStatus;
  range: { from: string; to: string };
  /** Present only when the books are on. Whether to trust it is in `profitComplete`. */
  profit: { salesPaise: number; costOfGoodsPaise: number; grossProfitPaise: number; expensesPaise: number; netProfitPaise: number } | null;
  profitComplete: boolean;
  profitReasons: ReportReason[];
  /** Cash in hand and the bank accounts: money that is actually there. */
  cashAndBank: { key: string; name: string; amountPaise: number }[];
  cashAndBankPaise: number;
  /** UPI, card and cheque receipts not yet in the bank. Real money owed by the bank, but not available yet, so never part of the total above. */
  awaitingSettlement: { key: string; name: string; amountPaise: number }[];
  awaitingSettlementPaise: number;
  owedToYouPaise: number;
  youOwePaise: number;
  stockValuePaise: number;
  unvaluedProducts: number;
  /** Customers or suppliers whose books balance disagrees with the party ledger. */
  partyMismatches: number;
};

/** The owner's simple summary. Accounting terms stay out of it: profit, money in hand, who owes whom, stock. */
export async function moneyOverview(session: SessionContext, range: { from: string; to: string }): Promise<MoneyOverview> {
  const status = await getAccountingStatus(session);
  const empty = { cashAndBank: [], cashAndBankPaise: 0, awaitingSettlement: [], awaitingSettlementPaise: 0, owedToYouPaise: 0, youOwePaise: 0, stockValuePaise: 0, unvaluedProducts: 0, partyMismatches: 0 };
  if (!status.active) return { active: false, status, range, profit: null, profitComplete: false, profitReasons: ["not_active"], ...empty };
  const db = getDb();
  const to = checkDate(range.to, "end");
  const pnl = await profitAndLoss(session, range);
  const balances = await balancesWithin(db, session.shopId, null, to);
  const byKey = (key: string) => balances.find((b) => b.key === key);
  const cashKeys = [...new Set([...["cash", "bank", "upi", "card", "cheques"], ...balances.filter((b) => isCashLikeKey(b.key)).map((b) => b.key)])];
  const moneyRows = cashKeys.map((key) => ({ key, name: byKey(key)?.name ?? key, amountPaise: byKey(key) ? debitNet(byKey(key)!) : 0 })).filter((row) => row.amountPaise !== 0);
  const awaiting = new Set(AWAITING_SETTLEMENT_KEYS);
  const cashAndBank = moneyRows.filter((row) => !awaiting.has(row.key));
  const awaitingSettlement = moneyRows.filter((row) => awaiting.has(row.key));
  const tie = await reconcileParties(db, session.shopId, status.openingRecorded);
  return {
    active: true,
    status,
    range,
    profit: { salesPaise: pnl.netSalesPaise, costOfGoodsPaise: pnl.costOfGoodsPaise, grossProfitPaise: pnl.grossProfitPaise, expensesPaise: pnl.expensesPaise, netProfitPaise: pnl.netProfitPaise },
    profitComplete: pnl.completeness.complete,
    profitReasons: pnl.completeness.reasons,
    cashAndBank,
    cashAndBankPaise: cashAndBank.reduce((sum, row) => sum + row.amountPaise, 0),
    awaitingSettlement,
    awaitingSettlementPaise: awaitingSettlement.reduce((sum, row) => sum + row.amountPaise, 0),
    owedToYouPaise: byKey("receivables") ? debitNet(byKey("receivables")!) : 0,
    youOwePaise: byKey("payables") ? creditNet(byKey("payables")!) : 0,
    stockValuePaise: byKey("inventory") ? debitNet(byKey("inventory")!) : 0,
    // Stock the books could not value (open gaps), not products whose price list cost is blank: the books' own figure.
    unvaluedProducts: status.openGaps.filter((gap) => gap.kind.startsWith("unvalued")).reduce((sum, gap) => sum + gap.count, 0),
    partyMismatches: tie.ready ? tie.mismatches.length : 0,
  };
}

/** Receipts taken but not yet in the bank: they stay in their own accounts until a settlement moves them. */
const AWAITING_SETTLEMENT_KEYS = ["upi", "card", "cheques"];

/** Month start and end for a date, used for the default range. */
export function monthRange(date = indiaDate()): { from: string; to: string } {
  return { from: `${date.slice(0, 8)}01`, to: date };
}
