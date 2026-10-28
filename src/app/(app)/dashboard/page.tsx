import type { Metadata } from "next";
import { cn } from "cn";
import Link from "next/link";
import { after } from "next/server";
import { ArrowUpRight, Clock, HandCoins, ReceiptText, Truck, Wallet } from "lucide-react";
import { KpiCard } from "@/components/nexora/kpi-card";
import { Money } from "@/components/nexora/money";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { SetupChecklist } from "@/components/nexora/setup-checklist";
import { RangeFilter } from "@/components/reports/range-filter";
import { TrendChart } from "@/components/reports/trend-chart";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { countPendingApprovals } from "@/modules/identity";
import { getDashboard, getOnboarding, raiseBusinessAlerts, type Dashboard } from "@/modules/reporting";
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
  const [data, pendingApprovalsCount, onboarding] = await Promise.all([
    getDashboard(session, { range: one(query.range), from: one(query.from), to: one(query.to) }),
    session.role === "owner" ? countPendingApprovals(session) : 0,
    getOnboarding(session),
  ]);
  // Today's stock / this week's dues alerts (deduplicated) are raised after the page is sent, from the
  // figures just loaded (and their date, even if midnight passes), so they never delay it or query twice.
  after(() => raiseBusinessAlerts(session, data.alerts, data.today).catch((error: unknown) => console.error(JSON.stringify({ level: "error", event: "business_alerts_failed", message: error instanceof Error ? error.message : String(error) }))));
  const { range, sales, money, expenses, cash, receivables, payables, stock, profit } = data;
  const isToday = range.from === data.today && range.to === data.today;
  const q = rangeQuery(range);
  const report = (kind: string, withRange = true) => `/reports/${kind}${withRange ? `?${q}` : ""}`;
  const methods = Object.entries(money.byMethod).filter(([, paise]) => paise !== 0);
  const alertCount = stock ? stock.counts.out + stock.counts.reorder + stock.counts.low : 0;

  return (
    <PageContainer>
      <PageIntro description={`${range.label} · what was billed, what came in and what is owed are kept separate`} />

      <QuickActions actions={data.actions} />

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

      <SetupChecklist
        shopId={session.shopId}
        onboarding={onboarding}
        // The "set up" card's figures are today's, so it only appears on the today view.
        today={
          range.from === data.today && range.to === data.today
            ? { billedPaise: sales.billedPaise, billCount: sales.billCount, collectedPaise: money.collectedPaise, receivablePaise: receivables?.receivablePaise ?? null, expensesPaise: expenses.totalPaise, profit: profit ? (profit.reliable ? { reliable: true, grossProfitPaise: profit.grossProfitPaise } : { reliable: false }) : null }
            : null
        }
      />

      <RangeFilter basePath="/dashboard" range={range} today={data.today} />

      <section aria-label="Billed sales" className="grid gap-4 rounded-2xl bg-panel p-5 text-panel-foreground sm:p-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)] lg:items-end">
        <Link href={report("sales")} className="group flex flex-col gap-1 rounded-xl focus-visible:outline-2">
          <span className="text-sm text-panel-muted">Billed sales · {range.label.toLowerCase()}</span>
          <span className="text-4xl font-bold tracking-tight tabular-nums sm:text-5xl">
            <Money paise={sales.billedPaise} />
          </span>
          <span className="inline-flex items-center gap-1 text-sm text-panel-muted group-hover:text-panel-foreground">
            {!onboarding.hasBills
              ? "No bills yet. Your first bill will show here."
              : sales.billCount === 0
                ? `No bills ${isToday ? "today yet" : "in this period"}.${sales.cancelledCount ? ` ${sales.cancelledCount} cancelled.` : ""}`
                : `${sales.billCount} ${sales.billCount === 1 ? "bill" : "bills"} incl. GST${sales.cancelledCount ? ` · ${sales.cancelledCount} cancelled, not counted` : ""}`}
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
          label="Money received"
          href={report("collections")}
          value={<Money paise={money.collectedPaise} />}
          detail={
            methods.length ? (
              <dl className="grid grid-cols-3 gap-2 pt-1">
                {[
                  { label: "Cash", paise: money.split.cashPaise },
                  { label: "UPI", paise: money.split.upiPaise },
                  { label: "Card/bank", paise: money.split.otherPaise },
                ].map((item) => (
                  <div key={item.label} className="flex flex-col">
                    <dt className="text-xs">{item.label}</dt>
                    <dd className="font-semibold text-foreground tabular-nums">{formatPaise(item.paise)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              "Nothing received yet. Credit sales are not counted until paid."
            )
          }
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

      {receivables ? <PendingCollections receivables={receivables} canCollect={data.actions.collect} viewAllHref={report("customer-dues", false)} /> : null}

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

const QUICK_ACTIONS = [
  { key: "sale", label: "New sale", hint: "Make a bill", href: "/billing", icon: ReceiptText },
  { key: "collect", label: "Collect udhaar", hint: "Payment against dues", href: "/customers", icon: HandCoins },
  { key: "expense", label: "Add expense", hint: "Tea, rent, transport", href: "/cashbook#section-add-an-expense", icon: Wallet },
  { key: "purchase", label: "Add purchase", hint: "Goods received", href: "/purchases/receive", icon: Truck },
] as const;

/** The day's four main jobs, as large buttons. Only the ones this person may do are shown. */
function QuickActions({ actions }: { actions: Dashboard["actions"] }) {
  const shown = QUICK_ACTIONS.filter((action) => actions[action.key]);
  if (shown.length === 0) return null;
  return (
    <nav aria-label="Quick actions" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {shown.map(({ key, label, hint, href, icon: Icon }, index) => (
        <Link
          key={key}
          href={href}
          className={cn(
            "flex min-h-16 items-center gap-3 rounded-2xl border p-3 transition-colors focus-visible:outline-2 sm:p-4",
            index === 0 ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90" : "border-border bg-card text-foreground hover:border-teal/50",
          )}
        >
          <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl", index === 0 ? "bg-primary-foreground/15" : "bg-teal-soft text-teal-strong")}>
            <Icon className="size-5" aria-hidden="true" />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="leading-snug font-semibold">{label}</span>
            <span className={cn("hidden text-xs sm:block", index === 0 ? "text-primary-foreground/80" : "text-muted-foreground")}>{hint}</span>
          </span>
        </Link>
      ))}
    </nav>
  );
}

/** Who to collect from: overdue first, then the biggest balances, each with a direct "Collect" button. */
function PendingCollections({ receivables, canCollect, viewAllHref }: { receivables: NonNullable<Dashboard["receivables"]>; canCollect: boolean; viewAllHref: string }) {
  const description =
    receivables.customersOwing === 0
      ? "Nobody owes you money"
      : `${formatPaise(receivables.receivablePaise)} from ${receivables.customersOwing} ${receivables.customersOwing === 1 ? "customer" : "customers"}${receivables.overdueCustomers ? ` · ${receivables.overdueCustomers} overdue` : ""}`;
  return (
    <SectionCard title="Pending collections (udhaar)" description={description} action={<ViewAll href={viewAllHref} />} flush>
      {receivables.top.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted-foreground">No pending udhaar. When you sell on credit, the customer shows here so you can collect the payment.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border pb-2">
          {receivables.top.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 px-5 py-3">
              <Link href={`/customers/${row.id}`} className="min-w-0 rounded-lg focus-visible:outline-2">
                <span className="block truncate font-medium text-foreground">{row.name}</span>
                <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  {row.overduePaise > 0 ? <Badge variant="danger">{formatPaise(row.overduePaise)} overdue</Badge> : row.tone === "amber" ? <Badge variant="warning">Due soon</Badge> : null}
                  {row.oldestDueDays !== null ? <span>Oldest bill {row.oldestDueDays} days</span> : null}
                </span>
              </Link>
              <span className="flex shrink-0 items-center gap-3">
                <Money paise={row.balancePaise} className="font-semibold" />
                {canCollect ? (
                  <Link href={`/customers/${row.id}#section-record-a-payment`} className={buttonVariants({ variant: "outline", size: "touch" })} aria-label={`Collect from ${row.name}`}>
                    Collect
                  </Link>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
