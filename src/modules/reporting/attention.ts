import { sql } from "drizzle-orm";
import { listBankAccounts } from "@/modules/accounting";
import { unmatchedBankSummary } from "@/modules/banking";
import { cashHealthOf } from "@/modules/cashbook";
import { hasPermission, type SessionContext } from "@/modules/identity";
import { getDb } from "@/server/db";
import { indiaDate } from "@/shared/financial-year";
import type { Dashboard } from "./business";

/**
 * "Needs attention": the few things the person should act on now, ranked by the rupees at stake (urgency breaks ties),
 * each with one direct action. Built only from what this role may see, so nothing here shows profit, cost or any figure
 * the dashboard would not already show them. One financial issue is one item: the same unmatched bank line, overdue bill
 * or short drawer is never counted by two items.
 */

export type AttentionKind = "dues" | "suppliers" | "bank" | "stock" | "negBank" | "unclosed" | "short" | "approvals" | "cash";

export type AttentionItem = {
  /** Unique, stable id (a bank account adds its own item). */
  id: string;
  kind: AttentionKind;
  /** Values for the sentence: amounts are paise (the screen formats them), the rest are counts or names. */
  params: Record<string, string | number>;
  /** Rupees at stake, 0 when the issue is not a money amount. */
  impactPaise: number;
  /** 3 blocks work, 2 is late or soon late, 1 can wait. */
  urgency: 1 | 2 | 3;
  href: string;
};

const ORDER: AttentionKind[] = ["cash", "negBank", "dues", "suppliers", "short", "unclosed", "bank", "approvals", "stock"];

export function rankAttention(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => b.impactPaise - a.impactPaise || b.urgency - a.urgency || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.id.localeCompare(b.id));
}

const DAY = 86_400_000;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** Days before today that had bills, payments or expenses but were never closed, once the shop has started closing days. */
async function unclosedDays(shopId: string, today: string): Promise<string[]> {
  const result = await getDb().execute<{ d: string }>(sql`
    with started as (select max(business_date) as last_closed from day_closings where shop_id = ${shopId}::uuid and status = 'closed')
    select to_char(d, 'YYYY-MM-DD') as d
    from started, generate_series(
      greatest(coalesce(started.last_closed + 1, ${addDays(today, -14)}::date), ${addDays(today, -14)}::date),
      ${addDays(today, -1)}::date, interval '1 day') as d
    where started.last_closed is not null
      and not exists (select 1 from day_closings c where c.shop_id = ${shopId}::uuid and c.business_date = d::date and c.status = 'closed')
      and (exists (select 1 from invoices i where i.shop_id = ${shopId}::uuid and i.business_date = d::date and i.status = 'issued')
        or exists (select 1 from payments p where p.shop_id = ${shopId}::uuid and p.business_date = d::date)
        or exists (select 1 from expenses e where e.shop_id = ${shopId}::uuid and e.business_date = d::date and e.status = 'recorded'))
    order by d`);
  return result.rows.map((row) => row.d);
}

/** Recent closed days where the drawer was short: the total shortage and the latest such day. */
async function recentShortDays(shopId: string, today: string): Promise<{ count: number; shortPaise: number; latest: string } | null> {
  const result = await getDb().execute<{ n: string; total: string | null; latest: string | null }>(sql`
    select count(*)::text as n, sum(-difference_paise)::text as total, to_char(max(business_date), 'YYYY-MM-DD') as latest
    from day_closings
    where shop_id = ${shopId}::uuid and status = 'closed' and difference_paise < 0 and business_date >= ${addDays(today, -14)}::date`);
  const row = result.rows[0];
  const count = Number(row?.n ?? 0);
  return count > 0 && row?.latest ? { count, shortPaise: Number(row.total ?? 0), latest: row.latest } : null;
}

export async function needsAttention(session: SessionContext, data: Pick<Dashboard, "today" | "receivables" | "payables" | "stock">, pendingApprovals: number): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  const today = data.today ?? indiaDate();

  // Customers who are late (only for people who may see customers: the dashboard leaves `receivables` out otherwise).
  if (data.receivables && data.receivables.overduePaise > 0) {
    items.push({ id: "dues", kind: "dues", params: { amount: data.receivables.overduePaise, count: data.receivables.overdueCustomers }, impactPaise: data.receivables.overduePaise, urgency: 2, href: "/customers" });
  }
  // Suppliers to pay: late now, or falling due within a week.
  if (data.payables) {
    const due = data.payables.overduePaise + data.payables.dueSoonPaise;
    if (due > 0) items.push({ id: "suppliers", kind: "suppliers", params: { amount: due }, impactPaise: due, urgency: data.payables.overduePaise > 0 ? 3 : 2, href: "/suppliers" });
  }
  if (data.stock) {
    const counts = data.stock.counts;
    const total = counts.out + counts.reorder + counts.low;
    if (total > 0) items.push({ id: "stock", kind: "stock", params: { count: total, out: counts.out, low: counts.reorder + counts.low }, impactPaise: 0, urgency: counts.out > 0 ? 3 : 2, href: "/inventory" });
  }

  // Bank: lines nobody has matched yet, and accounts the books show below zero (people who manage the bank only).
  const bank = await unmatchedBankSummary(session).catch(() => null);
  if (bank && bank.total > 0) items.push({ id: "bank", kind: "bank", params: { count: bank.total, amount: bank.amountPaise }, impactPaise: bank.amountPaise, urgency: 1, href: bank.accounts.length === 1 ? `/reports/money/bank/${bank.accounts[0]!.id}` : "/reports/money/bank" });
  if (bank) {
    const accounts = await listBankAccounts(session).catch(() => []);
    for (const account of accounts) {
      if (account.isActive && account.bookBalancePaise < 0) {
        items.push({ id: `negBank:${account.id}`, kind: "negBank", params: { name: account.name, amount: -account.bookBalancePaise }, impactPaise: -account.bookBalancePaise, urgency: 3, href: `/reports/money/bank/${account.id}` });
      }
    }
  }

  // The drawer: books and cashbook disagreeing (owner confirms it), days left open, days that ran short.
  const [canReconcile, canClose] = await Promise.all([hasPermission(session, "cash.reconcile"), hasPermission(session, "day.close")]);
  const health = canReconcile || canClose ? await cashHealthOf(getDb(), session.shopId).catch(() => null) : null;
  if (health?.needsReconciliation && canReconcile) {
    const gap = Math.abs(health.openingSettingPaise - health.openingInBooksPaise) + health.unpostedDifferences.reduce((sum, row) => sum + Math.abs(row.differencePaise), 0);
    items.push({ id: "cash", kind: "cash", params: { amount: gap }, impactPaise: gap, urgency: 3, href: "/cashbook" });
  }
  if (canClose) {
    const open = await unclosedDays(session.shopId, today).catch(() => []);
    if (open.length > 0) items.push({ id: "unclosed", kind: "unclosed", params: { count: open.length }, impactPaise: 0, urgency: 2, href: `/cashbook?date=${open[0]}` });
    // A short that was never posted is part of the "confirm the cash" item above, so it is not counted twice.
    if (!health?.needsReconciliation) {
      const short = await recentShortDays(session.shopId, today).catch(() => null);
      if (short) items.push({ id: "short", kind: "short", params: { amount: short.shortPaise, count: short.count }, impactPaise: short.shortPaise, urgency: 2, href: `/cashbook?date=${short.latest}` });
    }
  }

  if (pendingApprovals > 0) items.push({ id: "approvals", kind: "approvals", params: { count: pendingApprovals }, impactPaise: 0, urgency: 3, href: "/approvals" });
  return rankAttention(items);
}
