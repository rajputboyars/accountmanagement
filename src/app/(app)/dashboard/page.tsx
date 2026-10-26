import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, Clock, Plus } from "lucide-react";
import { KpiCard } from "@/components/nexora/kpi-card";
import { Money } from "@/components/nexora/money";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { RangeFilter } from "@/components/reports/range-filter";
import { TrendChart } from "@/components/reports/trend-chart";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { countPendingApprovals } from "@/modules/identity";
import { getDashboard } from "@/modules/reporting";
import { requireSession } from "@/server/auth";
import { formatPaise } from "@/shared/money";
import { rangeQuery } from "@/shared/report-range";

export const metadata: Metadata = { title: "Dashboard" };

type Props = PageProps<"/dashboard">;

export default function DashboardPage({ searchParams }: Props) {
  return (
    <ProtectedPage permission="reports.view" title="the owner dashboard">
      <DashboardContent searchParams={searchParams} />
    </ProtectedPage>
  );
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const METHOD: Record<string, string> = { cash: "Cash", upi: "UPI", bank: "Bank", cheque: "Cheque", card: "Card" };
const STATUS: Record<string, { label: string; variant: "danger" | "warning" | "neutral" }> = {
  out: { label: "Out", variant: "danger" },
  reorder: { label: "Reorder now", variant: "danger" },
  low: { label: "Low", variant: "warning" },
  needs_check: { label: "Check", variant: "neutral" },
};
const dateText = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
const timeText = (date: Date) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(date);

function ViewAll({ href, label = "View all" }: { href: string; label?: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-sm font-semibold whitespace-nowrap text-teal-strong hover:underline">
      {label}
      <ArrowUpRight className="size-3.5" aria-hidden="true" />
    </Link>
  );
}

async function DashboardContent({ searchParams }: Pick<Props, "searchParams">) {
  const query = await searchParams;
  const session = await requireSession();
  const [data, pendingApprovalsCount] = await Promise.all([
    getDashboard(session, { range: one(query.range), from: one(query.from), to: one(query.to) }),
    session.role === "owner" ? countPendingApprovals(session) : 0,
  ]);
  const { range, sales, money, expenses, cash, receivables, payables, stock, profit } = data;
  const q = rangeQuery(range);
  const report = (kind: string, withRange = true) => `/reports/${kind}${withRange ? `?${q}` : ""}`;
  const methods = Object.entries(money.byMethod).filter(([, paise]) => paise !== 0);
  const alertCount = stock ? stock.counts.out + stock.counts.reorder + stock.counts.low : 0;

  return (
    <PageContainer>
      <PageIntro
        description={`${range.label} · what was billed, what came in and what is owed are kept separate`}
        actions={
          <Link href="/billing" className={buttonVariants({ size: "touch" })}>
            <Plus aria-hidden="true" />
            New bill
          </Link>
        }
      />

      {pendingApprovalsCount > 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber/40 bg-amber-soft px-4 py-3 text-sm text-amber-ink">
          <div className="flex items-center gap-2">
            <Clock className="size-4 shrink-0" aria-hidden="true" />
            <span>
              <strong>{pendingApprovalsCount} approval request{pendingApprovalsCount > 1 ? "s" : ""}</strong> waiting for your review.
            </span>
          </div>
          <Link href="/approvals" className="inline-flex min-h-10 items-center font-semibold whitespace-nowrap text-teal-strong hover:underline">
            Review inbox &rarr;
          </Link>
        </div>
      ) : null}

      <RangeFilter basePath="/dashboard" range={range} today={data.today} />

      <section aria-label="Billed sales" className="grid gap-4 rounded-2xl bg-panel p-5 text-panel-foreground sm:p-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)] lg:items-end">
        <Link href={report("sales")} className="group flex flex-col gap-1 rounded-xl focus-visible:outline-2">
          <span className="text-sm text-panel-muted">Billed sales · {range.label.toLowerCase()}</span>
          <span className="text-4xl font-bold tracking-tight tabular-nums sm:text-5xl">
            <Money paise={sales.billedPaise} />
          </span>
          <span className="inline-flex items-center gap-1 text-sm text-panel-muted group-hover:text-panel-foreground">
            {sales.billCount} {sales.billCount === 1 ? "bill" : "bills"} incl. GST{sales.cancelledCount ? ` · ${sales.cancelledCount} cancelled, not counted` : ""}
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </span>
        </Link>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Paid at counter", paise: sales.paidAtCounterPaise, href: report("sales") },
            { label: "Given on credit", paise: sales.creditGivenPaise, href: report("sales") },
            { label: "Returns", paise: sales.creditNotesPaise, href: report("returns") },
            { label: "Refunds paid", paise: money.refundsPaise, href: report("collections") },
          ].map((item) => (
            <Link key={item.label} href={item.href} className="flex flex-col gap-0.5 rounded-xl bg-panel-foreground/10 p-3 hover:bg-panel-foreground/15">
              <dt className="text-xs text-panel-muted">{item.label}</dt>
              <dd className="text-lg font-semibold tabular-nums">
                <Money paise={item.paise} />
              </dd>
            </Link>
          ))}
        </dl>
      </section>

      <section aria-label="Money and dues" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Collected"
          href={report("collections")}
          value={<Money paise={money.collectedPaise} />}
          detail={methods.length ? <span className="tabular-nums">{methods.map(([method, paise]) => `${METHOD[method] ?? method} ${formatPaise(paise)}`).join(" · ")}</span> : "Nothing received yet"}
          footer={
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="neutral">Old dues {formatPaise(money.oldDuesPaise)}</Badge>
              {money.reversedPaise ? <Badge variant="warning">{formatPaise(money.reversedPaise)} reversed</Badge> : null}
            </div>
          }
        />
        {receivables ? (
          <KpiCard
            label="Customers owe you"
            href={report("customer-dues", false)}
            value={<Money paise={receivables.receivablePaise} />}
            detail={`${receivables.customersOwing} ${receivables.customersOwing === 1 ? "customer" : "customers"} · as of today`}
            footer={receivables.overduePaise ? <Badge variant="danger">Overdue {formatPaise(receivables.overduePaise)}</Badge> : <Badge variant="success">Nothing overdue</Badge>}
          />
        ) : null}
        {payables ? (
          <KpiCard
            label="You owe suppliers"
            href={report("supplier-dues", false)}
            value={<Money paise={payables.payablePaise} />}
            detail={data.purchases ? `Goods received ${range.label.toLowerCase()}: ${formatPaise(data.purchases.receivedPaise)}` : "As of today"}
            footer={payables.overduePaise ? <Badge variant="danger">Overdue {formatPaise(payables.overduePaise)}</Badge> : <Badge variant="success">Nothing overdue</Badge>}
          />
        ) : null}
        <KpiCard
          label="Expenses"
          href={report("expenses")}
          value={<Money paise={expenses.totalPaise} />}
          detail={expenses.byCategory.length ? expenses.byCategory.slice(0, 3).map((row) => `${row.label} ${formatPaise(row.totalPaise)}`).join(" · ") : "No expenses recorded"}
        />
        {cash ? (
          <KpiCard
            label="Net cash movement"
            href={range.from === range.to ? `/cashbook?date=${range.from}` : report("collections")}
            value={<Money paise={cash.netCashPaise} />}
            detail={<span className="tabular-nums">In {formatPaise(cash.inPaise)} · out {formatPaise(cash.outPaise)}</span>}
            footer={<span className="text-xs text-muted-foreground">Cash drawer only. Not sales, not profit.</span>}
          />
        ) : null}
        {profit ? (
          <KpiCard
            label="Gross profit"
            href={report("products")}
            value={profit.reliable ? <Money paise={profit.grossProfitPaise} /> : <span className="text-xl text-muted-foreground">Profit unavailable</span>}
            detail={profit.reliable ? <span className="tabular-nums">Sales {formatPaise(profit.revenuePaise)} − cost {formatPaise(profit.costPaise)}, before GST</span> : profit.reason}
            footer={profit.reliable ? null : <Badge variant="warning">Add cost prices to see profit</Badge>}
          />
        ) : null}
        {stock ? (
          <KpiCard
            label="Stock alerts"
            href={report("stock", false)}
            value={alertCount}
            detail={`${stock.counts.out} out · ${stock.counts.reorder} reorder now · ${stock.counts.low} low`}
            footer={stock.counts.needs_check ? <Badge variant="neutral">{stock.counts.needs_check} need checking</Badge> : null}
          />
        ) : null}
      </section>

      <div className="grid gap-4 xl:grid-cols-3">
        <SectionCard title={`Billed vs collected`} description={data.trend.by === "day" ? (range.days < 7 ? "Last 7 days" : range.label) : `${range.label}, by month`} className="xl:col-span-2" action={<ViewAll href={report("collections")} label="Payments" />}>
          <TrendChart points={data.trend.points} by={data.trend.by} />
        </SectionCard>
        <SectionCard title="Top-selling products" description="By billed value before GST" action={<ViewAll href={report("products")} />} flush>
          {data.topProducts.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-muted-foreground">No sales in this period.</p>
          ) : (
            <ol className="flex flex-col divide-y divide-border pb-2">
              {data.topProducts.map((product, index) => (
                <li key={product.productId} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="mr-2 text-muted-foreground tabular-nums">{index + 1}</span>
                    <span className="font-medium text-foreground">{product.name}</span>
                    <span className="block text-xs text-muted-foreground tabular-nums">
                      {Number(product.baseQty).toLocaleString("en-IN")} {product.unit} · {product.billCount} {product.billCount === 1 ? "bill" : "bills"}
                    </span>
                  </span>
                  <Money paise={product.valuePaise} className="font-semibold" />
                </li>
              ))}
            </ol>
          )}
        </SectionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {receivables ? (
          <SectionCard title="Customer dues" description="Highest balances today" action={<ViewAll href={report("customer-dues", false)} />} flush>
            {receivables.top.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-muted-foreground">No customer owes you anything.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border pb-2">
                {receivables.top.map((row) => (
                  <li key={row.id}>
                    <Link href={`/customers/${row.id}`} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm hover:bg-muted/50">
                      <span className="min-w-0">
                        <span className="font-medium text-foreground">{row.name}</span>
                        {row.oldestDueDays !== null ? <span className="block text-xs text-muted-foreground">Oldest bill {row.oldestDueDays} days</span> : null}
                      </span>
                      <span className="flex items-center gap-2">
                        {row.tone === "red" ? <Badge variant="danger">Overdue</Badge> : row.tone === "amber" ? <Badge variant="warning">Due soon</Badge> : null}
                        <Money paise={row.balancePaise} className="font-semibold" />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        ) : null}
        {payables ? (
          <SectionCard title="Supplier dues" description="What you owe, highest first" action={<ViewAll href={report("supplier-dues", false)} />} flush>
            {payables.top.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-muted-foreground">You owe no supplier anything.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border pb-2">
                {payables.top.map((row) => (
                  <li key={row.id}>
                    <Link href={`/suppliers/${row.id}`} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm hover:bg-muted/50">
                      <span className="min-w-0">
                        <span className="font-medium text-foreground">{row.name}</span>
                        <span className="block text-xs text-muted-foreground">{row.overduePaise ? `${formatPaise(row.overduePaise)} overdue` : row.nextDue ? `Next due ${dateText(row.nextDue)}` : "Not due yet"}</span>
                      </span>
                      <Money paise={row.owedPaise} className="font-semibold" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        ) : null}
        {stock ? (
          <SectionCard title="Low and out of stock" description="Worst first" action={<ViewAll href={report("stock", false)} />} flush>
            {stock.items.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-muted-foreground">Every product is above its reorder level.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border pb-2">
                {stock.items.map((row) => (
                  <li key={row.productId}>
                    <Link href={`/inventory/stock/${row.productId}`} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm hover:bg-muted/50">
                      <span className="min-w-0">
                        <span className="font-medium text-foreground">{row.name}</span>
                        <span className="block text-xs text-muted-foreground tabular-nums">
                          {row.qty ?? "Not counted"} {row.qty ? row.baseUnit : ""} · reorder at {row.reorderLevel}
                        </span>
                      </span>
                      <Badge variant={STATUS[row.status]?.variant ?? "neutral"}>{STATUS[row.status]?.label ?? row.status}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        ) : null}
        <SectionCard title="Expense breakdown" description={range.label} action={<ViewAll href={report("expenses")} />}>
          {expenses.byCategory.length === 0 ? (
            <p className="text-sm text-muted-foreground">No expenses in this period.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {expenses.byCategory.map((row) => (
                <li key={row.key} className="flex flex-col gap-1 text-sm">
                  <span className="flex justify-between gap-3">
                    <span className="text-foreground">{row.label}</span>
                    <Money paise={row.totalPaise} className="font-medium" />
                  </span>
                  <span className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <span className="block h-full rounded-full bg-amber" style={{ width: `${(row.totalPaise / expenses.totalPaise) * 100}%` }} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        <SectionCard title="Recent activity" description="Latest bills and payments" className="xl:col-span-2" flush>
          {data.recent.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-muted-foreground">Nothing recorded yet. Make the first bill to see it here.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border pb-2">
              {data.recent.map((item) => {
                const body = (
                  <>
                    <span className="min-w-0">
                      <span className="font-medium text-foreground">{item.kind}</span> · {item.label}
                      <span className="block text-xs text-muted-foreground">{timeText(item.at)}</span>
                    </span>
                    <Money paise={item.amountPaise} className="font-semibold" />
                  </>
                );
                return (
                  <li key={item.id}>
                    {item.href ? (
                      <Link href={item.href} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm hover:bg-muted/50">
                        {body}
                      </Link>
                    ) : (
                      <div className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>
      </div>
    </PageContainer>
  );
}
