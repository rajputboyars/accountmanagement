import type { Metadata } from "next";
import { cn } from "cn";
import Link from "next/link";
import { after } from "next/server";
import { ArrowUpRight, HandCoins, ReceiptText, Truck, Wallet } from "lucide-react";
import { ApprovalNotice } from "@/components/dashboard/approval-notice";
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
import { getLanguage, getT } from "@/server/i18n";
import { activityLabel, expenseLabel, rangeInSentence, rangeLabel as labelForRange } from "@/shared/i18n/labels";
import { unitShort } from "@/shared/i18n/unit-labels";
import { LANGUAGE_LOCALES, translateServerMessage, type Language, type MessageKey, type Translate } from "@/shared/i18n";
import { formatPaise } from "@/shared/money";
import { rangeQuery } from "@/shared/report-range";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.dashboard") };
}

type Props = PageProps<"/dashboard">;

export default function DashboardPage({ searchParams }: Props) {
  return (
    <ProtectedPage permission="reports.view" title="the owner dashboard" guide="dashboard">
      <DashboardContent searchParams={searchParams} />
    </ProtectedPage>
  );
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const STATUS: Record<string, { label: MessageKey; variant: "danger" | "warning" | "neutral" }> = {
  out: { label: "dashboard.status.out", variant: "danger" },
  reorder: { label: "dashboard.status.reorder", variant: "danger" },
  low: { label: "dashboard.status.low", variant: "warning" },
  needs_check: { label: "dashboard.status.needs_check", variant: "neutral" },
};
const dateText = (value: string, language: Language) => new Intl.DateTimeFormat(LANGUAGE_LOCALES[language].dates, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
const timeText = (date: Date, language: Language) => new Intl.DateTimeFormat(LANGUAGE_LOCALES[language].dates, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(date);

function ViewAll({ href, label, t }: { href: string; label?: string; t: Translate }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-sm font-semibold whitespace-nowrap text-teal-strong hover:underline">
      {label ?? t("common.viewAll")}
      <ArrowUpRight className="size-3.5" aria-hidden="true" />
    </Link>
  );
}

async function DashboardContent({ searchParams }: Pick<Props, "searchParams">) {
  const query = await searchParams;
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const bills = (count: number) => t(count === 1 ? "common.bill" : "common.bills", { count });
  const customers = (count: number) => t(count === 1 ? "common.customer" : "common.customers", { count });
  const [data, pendingApprovalsCount, onboarding] = await Promise.all([
    getDashboard(session, { range: one(query.range), from: one(query.from), to: one(query.to) }),
    session.role === "owner" ? countPendingApprovals(session) : 0,
    getOnboarding(session),
  ]);
  // Today's stock / this week's dues alerts (deduplicated) are raised after the page is sent, from the
  // figures just loaded (and their date, even if midnight passes), so they never delay it or query twice.
  after(() => raiseBusinessAlerts(session, data.alerts, data.today).catch((error: unknown) => console.error(JSON.stringify({ level: "error", event: "business_alerts_failed", message: error instanceof Error ? error.message : String(error) }))));
  const { range, sales, money, expenses, cash, receivables, payables, stock, profit } = data;
  const rangeLabel = labelForRange(t, range);
  const rangeText = rangeInSentence(t, range);
  const isToday = range.from === data.today && range.to === data.today;
  const q = rangeQuery(range);
  const report = (kind: string, withRange = true) => `/reports/${kind}${withRange ? `?${q}` : ""}`;
  const methods = Object.entries(money.byMethod).filter(([, paise]) => paise !== 0);
  const alertCount = stock ? stock.counts.out + stock.counts.reorder + stock.counts.low : 0;

  return (
    <PageContainer>
      <PageIntro description={t("dashboard.intro", { range: rangeLabel })} />

      <QuickActions actions={data.actions} t={t} />

      {pendingApprovalsCount > 0 ? <ApprovalNotice count={pendingApprovalsCount} t={t} /> : null}

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

      <section aria-label={t("dashboard.billedSales")} className="grid gap-4 rounded-2xl bg-panel p-5 text-panel-foreground sm:p-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)] lg:items-end">
        <Link href={report("sales")} className="group flex flex-col gap-1 rounded-xl focus-visible:outline-2">
          <span className="text-sm text-panel-muted">{t("dashboard.billedSalesRange", { range: rangeText })}</span>
          <span className="text-4xl font-bold tracking-tight tabular-nums sm:text-5xl">
            <Money paise={sales.billedPaise} />
          </span>
          <span className="inline-flex items-center gap-1 text-sm text-panel-muted group-hover:text-panel-foreground">
            {!onboarding.hasBills
              ? t("dashboard.noBillsEver")
              : sales.billCount === 0
                ? `${t(isToday ? "dashboard.noBillsToday" : "dashboard.noBillsPeriod")}${sales.cancelledCount ? ` ${t("dashboard.cancelledCount", { count: sales.cancelledCount })}` : ""}`
                : `${t("dashboard.billsInclGst", { bills: bills(sales.billCount) })}${sales.cancelledCount ? ` · ${t("dashboard.cancelledNotCounted", { count: sales.cancelledCount })}` : ""}`}
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </span>
        </Link>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: t("dashboard.paidAtCounter"), paise: sales.paidAtCounterPaise, href: report("sales") },
            { label: t("dashboard.givenOnCredit"), paise: sales.creditGivenPaise, href: report("sales") },
            { label: t("dashboard.returns"), paise: sales.creditNotesPaise, href: report("returns") },
            { label: t("dashboard.refundsPaid"), paise: money.refundsPaise, href: report("collections") },
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

      <section aria-label={t("dashboard.moneyAndDues")} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          help="paymentReceived"
          label={t("dashboard.moneyReceived")}
          href={report("collections")}
          value={<Money paise={money.collectedPaise} />}
          detail={
            methods.length ? (
              <dl className="grid grid-cols-3 gap-2 pt-1">
                {[
                  { label: t("common.cash"), paise: money.split.cashPaise },
                  { label: t("common.upi"), paise: money.split.upiPaise },
                  { label: t("common.cardBank"), paise: money.split.otherPaise },
                ].map((item) => (
                  <div key={item.label} className="flex flex-col">
                    <dt className="text-xs">{item.label}</dt>
                    <dd className="font-semibold text-foreground tabular-nums">{formatPaise(item.paise)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              t("dashboard.nothingReceived")
            )
          }
          footer={
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="neutral">{t("dashboard.oldDues", { amount: formatPaise(money.oldDuesPaise) })}</Badge>
              {money.reversedPaise ? <Badge variant="warning">{t("dashboard.reversed", { amount: formatPaise(money.reversedPaise) })}</Badge> : null}
            </div>
          }
        />
        {receivables ? (
          <KpiCard
            label={t("dashboard.customersOweYou")}
            href={report("customer-dues", false)}
            value={<Money paise={receivables.receivablePaise} />}
            detail={t("dashboard.asOfToday", { customers: customers(receivables.customersOwing) })}
            footer={receivables.overduePaise ? <Badge variant="danger">{t("common.overdue", { amount: formatPaise(receivables.overduePaise) })}</Badge> : <Badge variant="success">{t("common.nothingOverdue")}</Badge>}
          />
        ) : null}
        {payables ? (
          <KpiCard
            label={t("dashboard.youOweSuppliers")}
            href={report("supplier-dues", false)}
            value={<Money paise={payables.payablePaise} />}
            detail={data.purchases ? t("dashboard.goodsReceived", { range: rangeText, amount: formatPaise(data.purchases.receivedPaise) }) : t("dashboard.asOfTodayAlone")}
            footer={payables.overduePaise ? <Badge variant="danger">{t("common.overdue", { amount: formatPaise(payables.overduePaise) })}</Badge> : <Badge variant="success">{t("common.nothingOverdue")}</Badge>}
          />
        ) : null}
        <KpiCard
          help="expenses"
          label={t("dashboard.expenses")}
          href={report("expenses")}
          value={<Money paise={expenses.totalPaise} />}
          detail={expenses.byCategory.length ? expenses.byCategory.slice(0, 3).map((row) => `${expenseLabel(t, row)} ${formatPaise(row.totalPaise)}`).join(" · ") : t("dashboard.noExpensesRecorded")}
        />
        {cash ? (
          <KpiCard
            label={t("dashboard.netCash")}
            href={range.from === range.to ? `/cashbook?date=${range.from}` : report("collections")}
            value={<Money paise={cash.netCashPaise} />}
            detail={<span className="tabular-nums">{t("dashboard.cashInOut", { in: formatPaise(cash.inPaise), out: formatPaise(cash.outPaise) })}</span>}
            footer={<span className="text-xs text-muted-foreground">{t("dashboard.cashOnly")}</span>}
          />
        ) : null}
        {profit ? (
          <KpiCard
            help="grossProfit"
            label={t("dashboard.grossProfit")}
            href={report("products")}
            value={profit.reliable ? <Money paise={profit.grossProfitPaise} /> : <span className="text-xl text-muted-foreground">{t("dashboard.profitUnavailable")}</span>}
            detail={profit.reliable ? <span className="tabular-nums">{t("dashboard.profitDetail", { revenue: formatPaise(profit.revenuePaise), cost: formatPaise(profit.costPaise) })}</span> : translateServerMessage(profit.reason, language)}
            footer={profit.reliable ? null : <Badge variant="warning">{t("dashboard.addCostPrices")}</Badge>}
          />
        ) : null}
        {stock ? (
          <KpiCard
            label={t("dashboard.stockAlerts")}
            href={report("stock", false)}
            value={alertCount}
            detail={t("dashboard.stockCounts", { out: stock.counts.out, reorder: stock.counts.reorder, low: stock.counts.low })}
            footer={stock.counts.needs_check ? <Badge variant="neutral">{t("dashboard.needChecking", { count: stock.counts.needs_check })}</Badge> : null}
          />
        ) : null}
      </section>

      {receivables ? <PendingCollections receivables={receivables} canCollect={data.actions.collect} viewAllHref={report("customer-dues", false)} t={t} customersText={customers} /> : null}

      <div className="grid gap-4 xl:grid-cols-3">
        <SectionCard title={t("dashboard.billedVsCollected")} description={data.trend.by === "day" ? (range.days < 7 ? t("range.last7") : rangeLabel) : t("dashboard.rangeByMonth", { range: rangeLabel })} className="xl:col-span-2" action={<ViewAll t={t} href={report("collections")} label={t("dashboard.payments")} />}>
          <TrendChart points={data.trend.points} by={data.trend.by} />
        </SectionCard>
        <SectionCard title={t("dashboard.topProducts")} description={t("dashboard.topProductsDescription")} action={<ViewAll t={t} href={report("products")} />} flush>
          {data.topProducts.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-muted-foreground">{t("dashboard.noSalesPeriod")}</p>
          ) : (
            <ol className="flex flex-col divide-y divide-border pb-2">
              {data.topProducts.map((product, index) => (
                <li key={product.productId} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="mr-2 text-muted-foreground tabular-nums">{index + 1}</span>
                    <span className="font-medium text-foreground">{product.name}</span>
                    <span className="block text-xs text-muted-foreground tabular-nums">
                      {Number(product.baseQty).toLocaleString("en-IN")} {unitShort(t, product.unit)} · {bills(product.billCount)}
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
          <SectionCard title={t("dashboard.supplierDues")} description={t("dashboard.supplierDuesDescription")} action={<ViewAll t={t} href={report("supplier-dues", false)} />} flush>
            {payables.top.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-muted-foreground">{t("dashboard.noSupplierDues")}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border pb-2">
                {payables.top.map((row) => (
                  <li key={row.id}>
                    <Link href={`/suppliers/${row.id}`} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm hover:bg-muted/50">
                      <span className="min-w-0">
                        <span className="font-medium text-foreground">{row.name}</span>
                        <span className="block text-xs text-muted-foreground">{row.overduePaise ? t("common.overdueAmount", { amount: formatPaise(row.overduePaise) }) : row.nextDue ? t("dashboard.nextDue", { date: dateText(row.nextDue, language) }) : t("dashboard.notDueYet")}</span>
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
          <SectionCard help="lowStock" title={t("dashboard.lowStock")} description={t("dashboard.lowStockDescription")} action={<ViewAll t={t} href={report("stock", false)} />} flush>
            {stock.items.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-muted-foreground">{t("dashboard.allStocked")}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border pb-2">
                {stock.items.map((row) => (
                  <li key={row.productId}>
                    <Link href={`/inventory/stock/${row.productId}`} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm hover:bg-muted/50">
                      <span className="min-w-0">
                        <span className="font-medium text-foreground">{row.name}</span>
                        <span className="block text-xs text-muted-foreground tabular-nums">
                          {row.qty ?? t("dashboard.notCounted")} {row.qty ? unitShort(t, row.baseUnit) : ""} · {t("dashboard.reorderAt", { level: row.reorderLevel })}
                        </span>
                      </span>
                      <Badge variant={STATUS[row.status]?.variant ?? "neutral"}>{STATUS[row.status] ? t(STATUS[row.status]!.label) : row.status}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        ) : null}
        <SectionCard help="grossVsTotalProfit" title={t("dashboard.expenseBreakdown")} description={rangeLabel} action={<ViewAll t={t} href={report("expenses")} />}>
          {expenses.byCategory.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("dashboard.noExpensesPeriod")}</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {expenses.byCategory.map((row) => (
                <li key={row.key} className="flex flex-col gap-1 text-sm">
                  <span className="flex justify-between gap-3">
                    <span className="text-foreground">{expenseLabel(t, row)}</span>
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
        <SectionCard title={t("dashboard.recentActivity")} description={t("dashboard.recentActivityDescription")} className="xl:col-span-2" flush>
          {data.recent.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-muted-foreground">{t("dashboard.noActivity")}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border pb-2">
              {data.recent.map((item) => {
                const body = (
                  <>
                    <span className="min-w-0">
                      <span className="font-medium text-foreground">{translateServerMessage(item.kind, language)}</span> · {activityLabel(item.label, language)}
                      <span className="block text-xs text-muted-foreground">{timeText(item.at, language)}</span>
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
  { key: "sale", label: "dashboard.action.sale", hint: "dashboard.action.saleHint", href: "/billing", icon: ReceiptText },
  { key: "collect", label: "dashboard.action.collect", hint: "dashboard.action.collectHint", href: "/customers", icon: HandCoins },
  { key: "expense", label: "dashboard.action.expense", hint: "dashboard.action.expenseHint", href: "/cashbook#section-add-an-expense", icon: Wallet },
  { key: "purchase", label: "dashboard.action.purchase", hint: "dashboard.action.purchaseHint", href: "/purchases/receive", icon: Truck },
] as const;

/** The day's four main jobs, as large buttons. Only the ones this person may do are shown. */
function QuickActions({ actions, t }: { actions: Dashboard["actions"]; t: Translate }) {
  const shown = QUICK_ACTIONS.filter((action) => actions[action.key]);
  if (shown.length === 0) return null;
  return (
    <nav aria-label={t("dashboard.quickActions")} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {shown.map(({ key, label, hint, href, icon: Icon }, index) => (
        <Link
          key={key}
          href={href}
          className={cn(
            "flex min-h-16 items-center gap-2 rounded-2xl border p-2.5 transition-colors focus-visible:outline-2 sm:gap-3 sm:p-4",
            index === 0 ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90" : "border-border bg-card text-foreground hover:border-teal/50",
          )}
        >
          <span className={cn("grid size-9 shrink-0 place-items-center rounded-xl sm:size-10", index === 0 ? "bg-primary-foreground/15" : "bg-teal-soft text-teal-strong")}>
            <Icon className="size-5" aria-hidden="true" />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="text-sm leading-snug font-semibold sm:text-base">{t(label)}</span>
            <span className={cn("hidden text-xs sm:block", index === 0 ? "text-primary-foreground/80" : "text-muted-foreground")}>{t(hint)}</span>
          </span>
        </Link>
      ))}
    </nav>
  );
}

/** Who to collect from: overdue first, then the biggest balances, each with a direct "Collect" button. */
function PendingCollections({ receivables, canCollect, viewAllHref, t, customersText }: { receivables: NonNullable<Dashboard["receivables"]>; canCollect: boolean; viewAllHref: string; t: Translate; customersText: (count: number) => string }) {
  const description =
    receivables.customersOwing === 0
      ? t("dashboard.nobodyOwes")
      : `${t("dashboard.owedFrom", { amount: formatPaise(receivables.receivablePaise), customers: customersText(receivables.customersOwing) })}${receivables.overdueCustomers ? ` · ${t("dashboard.overdueCustomers", { count: receivables.overdueCustomers })}` : ""}`;
  return (
    <SectionCard title={t("dashboard.pendingCollections")} description={description} action={<ViewAll t={t} href={viewAllHref} />} flush>
      {receivables.top.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted-foreground">{t("dashboard.noPending")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border pb-2">
          {receivables.top.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 px-5 py-3">
              <Link href={`/customers/${row.id}`} className="min-w-0 rounded-lg focus-visible:outline-2">
                <span className="block truncate font-medium text-foreground">{row.name}</span>
                <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  {row.overduePaise > 0 ? <Badge variant="danger">{t("common.overdueAmount", { amount: formatPaise(row.overduePaise) })}</Badge> : row.tone === "amber" ? <Badge variant="warning">{t("dashboard.dueSoon")}</Badge> : null}
                  {row.oldestDueDays !== null ? <span>{t("dashboard.oldestBill", { days: row.oldestDueDays })}</span> : null}
                </span>
              </Link>
              <span className="flex shrink-0 items-center gap-3">
                <Money paise={row.balancePaise} className="font-semibold" />
                {canCollect ? (
                  <Link href={`/customers/${row.id}#section-record-a-payment`} className={buttonVariants({ variant: "outline", size: "touch" })} aria-label={t("dashboard.collectFrom", { name: row.name })}>
                    {t("dashboard.collect")}
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
