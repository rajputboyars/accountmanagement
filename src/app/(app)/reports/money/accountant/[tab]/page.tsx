import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { accountLabel, CompletenessNote, eventLabel } from "@/components/money/money-bits";
import { Money } from "@/components/nexora/money";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { RangeFilter } from "@/components/reports/range-filter";
import { buttonVariants } from "@/components/ui/button";
import { accountBalances, accountLedger, balanceSheet, cashFlow, LEDGER_ROWS, listJournals, profitAndLoss, trialBalance, type Completeness } from "@/modules/accounting";
import { requireSession } from "@/server/auth";
import { getLanguage, getT } from "@/server/i18n";
import { CHART } from "@/shared/accounting";
import { indiaDate } from "@/shared/financial-year";
import { billDate, rangeLabel } from "@/shared/i18n/labels";
import type { Translate } from "@/shared/i18n";
import { rangeQuery, resolveRange } from "@/shared/report-range";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("money.acc.title") };
}

type Props = { params: Promise<{ tab: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const TABS = ["pl", "trial", "balance", "cash", "ledger", "journals"] as const;
type Tab = (typeof TABS)[number];
const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default function AccountantPage({ params, searchParams }: Props) {
  return (
    <ProtectedPage permission="profit.view" title="Accountant view">
      <AccountantView params={params} searchParams={searchParams} />
    </ProtectedPage>
  );
}

const th = "py-2 pr-3 text-left text-xs font-medium text-muted-foreground";
const num = "py-2 pr-3 text-right tabular-nums";

function Scroll({ children }: { children: React.ReactNode }) {
  return <div className="overflow-x-auto px-5 pb-5">{children}</div>;
}

function AmountRow({ label, paise, strong, indent }: { label: string; paise: number; strong?: boolean; indent?: boolean }) {
  return (
    <tr className={`border-t border-border ${strong ? "font-semibold" : ""}`}>
      <td className={`py-2 pr-3 ${indent ? "pl-4" : ""}`}>{label}</td>
      <td className={num}>
        <Money paise={paise} withPaise />
      </td>
    </tr>
  );
}

async function AccountantView({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const [{ tab }, query, session, t, language] = await Promise.all([params, searchParams, requireSession(), getT(), getLanguage()]);
  if (!(TABS as readonly string[]).includes(tab)) notFound();
  const today = indiaDate();
  const range = resolveRange({ range: one(query.range) ?? "month", from: one(query.from), to: one(query.to) }, today);
  const current = tab as Tab;
  const base = `/reports/money/accountant/${current}`;
  const label = (key: string, fallback: string) => accountLabel(t, key, fallback);

  const body = await renderTab(current, { session, t, range, language, query: { account: one(query.account), page: Number(one(query.page) ?? "1") || 1 }, label });
  return (
    <PageContainer>
      <Link href="/reports/money" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("money.back")}
      </Link>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{t("money.acc.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("money.acc.description")}</p>
        <p className="text-xs text-muted-foreground">{t("money.acc.notice")}</p>
      </div>
      <nav aria-label={t("money.acc.title")} className="flex flex-wrap gap-1 rounded-xl border border-border bg-card p-1">
        {TABS.map((entry) => (
          <Link
            key={entry}
            href={`/reports/money/accountant/${entry}?${rangeQuery(range)}`}
            aria-current={entry === current ? "page" : undefined}
            className={`inline-flex min-h-10 items-center rounded-lg px-3 text-sm font-medium ${entry === current ? "bg-teal-strong text-white" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
          >
            {t(`money.acc.tab.${entry}`)}
          </Link>
        ))}
      </nav>
      <RangeFilter basePath={base} range={range} today={today} />
      {body}
    </PageContainer>
  );
}

type RenderInput = {
  session: Awaited<ReturnType<typeof requireSession>>;
  t: Translate;
  range: ReturnType<typeof resolveRange>;
  language: Awaited<ReturnType<typeof getLanguage>>;
  query: { account?: string; page: number };
  label: (key: string, fallback: string) => string;
};

function Verdict({ completeness, t }: { completeness: Completeness; t: Translate }) {
  return <CompletenessNote completeness={completeness} t={t} fixHref={completeness.reasons.some((reason) => ["opening_missing", "opening_unverified", "clearing_not_zero"].includes(reason)) ? "/reports/money/setup" : undefined} />;
}

async function renderTab(tab: Tab, { session, t, range, language, query, label }: RenderInput) {
  const period = { from: range.from, to: range.to };
  if (tab === "pl") {
    const report = await profitAndLoss(session, period);
    return (
      <SectionCard title={t("money.acc.tab.pl")} description={rangeLabel(t, range)} flush>
        <div className="px-5 pb-3">
          <Verdict completeness={report.completeness} t={t} />
        </div>
        <Scroll>
          <table className="w-full min-w-[22rem] text-sm">
            <tbody>
              {report.sales.map((row) => (
                <AmountRow key={row.key} label={label(row.key, row.name)} paise={row.amountPaise} indent />
              ))}
              <AmountRow label={t("money.acc.netSales")} paise={report.netSalesPaise} strong />
              {report.costOfGoods.map((row) => (
                <AmountRow key={row.key} label={label(row.key, row.name)} paise={-row.amountPaise} indent />
              ))}
              <AmountRow label={t("money.grossProfit")} paise={report.grossProfitPaise} strong />
              {report.otherIncome.map((row) => (
                <AmountRow key={row.key} label={label(row.key, row.name)} paise={row.amountPaise} indent />
              ))}
              {report.expenses.map((row) => (
                <AmountRow key={row.key} label={label(row.key, row.name)} paise={-row.amountPaise} indent />
              ))}
              <AmountRow label={t("money.netProfit")} paise={report.netProfitPaise} strong />
            </tbody>
          </table>
        </Scroll>
      </SectionCard>
    );
  }
  if (tab === "trial") {
    const report = await trialBalance(session, range.to);
    return (
      <SectionCard title={t("money.acc.tab.trial")} description={t("money.acc.asOf", { date: billDate(range.to, language) })} flush>
        <div className="flex flex-wrap items-center gap-3 px-5 pb-3">
          <Verdict completeness={report.completeness} t={t} />
          <span className={`text-xs font-medium ${report.balanced ? "text-success" : "text-danger"}`}>{report.balanced ? t("money.acc.balanced") : t("money.acc.notBalanced")}</span>
        </div>
        <Scroll>
          <table className="w-full min-w-[30rem] text-sm">
            <thead>
              <tr>
                <th className={th}>{t("money.acc.code")}</th>
                <th className={th}>{t("money.acc.account")}</th>
                <th className={`${th} text-right`}>{t("money.acc.debit")}</th>
                <th className={`${th} text-right`}>{t("money.acc.credit")}</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.key} className="border-t border-border">
                  <td className="py-2 pr-3 tabular-nums text-muted-foreground">{row.code}</td>
                  <td className="py-2 pr-3">
                    <Link href={`/reports/money/accountant/ledger?${rangeQuery(range)}&account=${row.key}`} className="text-teal-strong hover:underline">
                      {label(row.key, row.name)}
                    </Link>
                  </td>
                  <td className={num}>{row.debitPaise ? <Money paise={row.debitPaise} withPaise /> : null}</td>
                  <td className={num}>{row.creditPaise ? <Money paise={row.creditPaise} withPaise /> : null}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-border font-semibold">
                <td />
                <td className="py-2 pr-3">{t("common.total")}</td>
                <td className={num}>
                  <Money paise={report.totalDebitPaise} withPaise />
                </td>
                <td className={num}>
                  <Money paise={report.totalCreditPaise} withPaise />
                </td>
              </tr>
            </tbody>
          </table>
        </Scroll>
      </SectionCard>
    );
  }
  if (tab === "balance") {
    const report = await balanceSheet(session, range.to);
    return (
      <SectionCard title={t("money.acc.tab.balance")} description={t("money.acc.asOf", { date: billDate(range.to, language) })} flush>
        <div className="flex flex-wrap items-center gap-3 px-5 pb-3">
          <Verdict completeness={report.completeness} t={t} />
          <span className={`text-xs font-medium ${report.balanced ? "text-success" : "text-danger"}`}>{report.balanced ? t("money.acc.balanced") : t("money.acc.notBalanced")}</span>
        </div>
        <Scroll>
          <table className="w-full min-w-[22rem] text-sm">
            <tbody>
              <tr>
                <th colSpan={2} className={th}>
                  {t("money.acc.assets")}
                </th>
              </tr>
              {report.assets.map((row) => (
                <AmountRow key={row.key} label={label(row.key, row.name)} paise={row.amountPaise} indent />
              ))}
              <AmountRow label={t("money.acc.totalAssets")} paise={report.totalAssetsPaise} strong />
              <tr>
                <th colSpan={2} className={`${th} pt-4`}>
                  {t("money.acc.liabilities")}
                </th>
              </tr>
              {report.liabilities.map((row) => (
                <AmountRow key={row.key} label={label(row.key, row.name)} paise={row.amountPaise} indent />
              ))}
              <AmountRow label={t("money.acc.totalLiabilities")} paise={report.totalLiabilitiesPaise} strong />
              <tr>
                <th colSpan={2} className={`${th} pt-4`}>
                  {t("money.acc.equity")}
                </th>
              </tr>
              {report.equity.map((row) => (
                <AmountRow key={row.key} label={label(row.key, row.name)} paise={row.amountPaise} indent />
              ))}
              <AmountRow label={t("money.acc.earnings")} paise={report.earningsPaise} indent />
              <AmountRow label={t("money.acc.equity")} paise={report.totalEquityPaise} strong />
              <tr>
                <th colSpan={2} className={`${th} pt-4`}>
                  {t("money.stockValue")}
                </th>
              </tr>
              <AmountRow label={t("money.acc.stockBooks")} paise={report.stockValue.booksPaise} indent />
              <AmountRow label={t("money.acc.stockAtCost")} paise={report.stockValue.atCostPaise} indent />
            </tbody>
          </table>
        </Scroll>
      </SectionCard>
    );
  }
  if (tab === "cash") {
    const report = await cashFlow(session, period);
    return (
      <SectionCard title={t("money.acc.tab.cash")} description={rangeLabel(t, range)} flush>
        <div className="flex flex-wrap items-center gap-3 px-5 pb-3">
          <Verdict completeness={report.completeness} t={t} />
          <span className={`text-xs font-medium ${report.reconciles ? "text-success" : "text-danger"}`}>{report.reconciles ? t("money.acc.reconciles") : t("money.acc.notReconcile")}</span>
        </div>
        <Scroll>
          <table className="w-full min-w-[22rem] text-sm">
            <tbody>
              <AmountRow label={t("money.acc.openingCash")} paise={report.openingCashPaise} strong />
              {(
                [
                  ["money.acc.operating", "operating", report.operatingPaise],
                  ["money.acc.investing", "investing", report.investingPaise],
                  ["money.acc.financing", "financing", report.financingPaise],
                  ["money.acc.unclassified", "none", report.unclassifiedPaise],
                ] as const
              )
                .filter(([, , amount]) => amount !== 0)
                .map(([key, cls, amount]) => (
                  <FlowGroup key={cls} title={t(key)} total={amount} rows={report.details.filter((row) => row.cashFlow === cls)} label={label} />
                ))}
              <AmountRow label={t("money.acc.netChange")} paise={report.netChangePaise} strong />
              <AmountRow label={t("money.acc.closingCash")} paise={report.closingCashPaise} strong />
              {report.accounts.map((row) => (
                <AmountRow key={row.key} label={label(row.key, row.name)} paise={row.amountPaise} indent />
              ))}
            </tbody>
          </table>
        </Scroll>
      </SectionCard>
    );
  }
  if (tab === "ledger") {
    const balances = await accountBalances(session, {});
    const ledger = query.account ? await accountLedger(session, { account: query.account, ...period }) : null;
    return (
      <SectionCard title={t("money.acc.tab.ledger")} description={rangeLabel(t, range)} flush>
        <form action="/reports/money/accountant/ledger" className="flex flex-wrap items-end gap-2 px-5 pb-3">
          <input type="hidden" name="range" value="custom" />
          <input type="hidden" name="from" value={range.from} />
          <input type="hidden" name="to" value={range.to} />
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            {t("money.acc.account")}
            <select name="account" defaultValue={query.account ?? ""} className="h-10 rounded-lg border border-input bg-background px-2 text-sm text-foreground">
              <option value="">{t("money.acc.chooseAccount")}</option>
              {balances.map((row) => (
                <option key={row.systemKey} value={row.systemKey}>
                  {row.code} · {label(row.systemKey, row.name)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={buttonVariants({ variant: "outline", className: "h-10" })}>
            {t("money.acc.show")}
          </button>
        </form>
        {ledger?.account ? (
          <Scroll>
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr>
                  <th className={th}>{t("money.acc.date")}</th>
                  <th className={th}>{t("money.acc.entry")}</th>
                  <th className={`${th} text-right`}>{t("money.acc.debit")}</th>
                  <th className={`${th} text-right`}>{t("money.acc.credit")}</th>
                  <th className={`${th} text-right`}>{t("money.acc.balance")}</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-border text-muted-foreground">
                  <td className="py-2 pr-3" colSpan={4}>
                    {t("money.acc.opening")}
                  </td>
                  <td className={num}>
                    <Money paise={ledger.openingBalancePaise} withPaise />
                  </td>
                </tr>
                {ledger.lines.map((line) => (
                  <tr key={`${line.journalId}-${line.balancePaise}-${line.debitPaise}-${line.creditPaise}`} className="border-t border-border">
                    <td className="py-2 pr-3 whitespace-nowrap">{billDate(line.entryDate, language)}</td>
                    <td className="py-2 pr-3">
                      {line.href ? (
                        <Link href={line.href} className="text-teal-strong hover:underline" title={t("money.acc.open")}>
                          {eventLabel(t, line.event)}
                        </Link>
                      ) : (
                        eventLabel(t, line.event)
                      )}
                    </td>
                    <td className={num}>{line.debitPaise ? <Money paise={line.debitPaise} withPaise /> : null}</td>
                    <td className={num}>{line.creditPaise ? <Money paise={line.creditPaise} withPaise /> : null}</td>
                    <td className={num}>
                      <Money paise={line.balancePaise} withPaise />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ledger.lines.length === 0 ? <p className="pt-3 text-sm text-muted-foreground">{t("money.acc.noRows")}</p> : null}
            {ledger.truncated ? <p className="pt-3 text-xs text-muted-foreground">{t("money.acc.more")} ({LEDGER_ROWS})</p> : null}
          </Scroll>
        ) : null}
      </SectionCard>
    );
  }
  const journalPage = await listJournals(session, { ...period, page: query.page });
  return (
    <SectionCard title={t("money.acc.tab.journals")} description={rangeLabel(t, range)} flush>
      <Scroll>
        {journalPage.journals.length === 0 ? <p className="text-sm text-muted-foreground">{t("money.acc.noRows")}</p> : null}
        <ul className="flex flex-col gap-3">
          {journalPage.journals.map((journal) => (
            <li key={journal.id} className="rounded-xl border border-border p-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {billDate(journal.entryDate, language)} · {journal.href ? <Link href={journal.href} className="text-teal-strong hover:underline">{eventLabel(t, journal.event)}</Link> : eventLabel(t, journal.event)}
                </span>
                {journal.memo ? <span className="text-xs text-muted-foreground">{journal.memo}</span> : null}
              </div>
              <table className="mt-2 w-full text-xs">
                <tbody>
                  {journal.lines.map((line, index) => (
                    <tr key={index} className="border-t border-border">
                      <td className="py-1 pr-2">{label(accountKeyOf(line.code), line.account)}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">{line.debitPaise ? <Money paise={line.debitPaise} withPaise /> : null}</td>
                      <td className="py-1 text-right tabular-nums">{line.creditPaise ? <Money paise={line.creditPaise} withPaise /> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </li>
          ))}
        </ul>
        {journalPage.hasMore ? (
          <Link href={`/reports/money/accountant/journals?${rangeQuery(range)}&page=${query.page + 1}`} className="mt-3 inline-block text-sm font-semibold text-teal-strong hover:underline">
            {t("money.acc.next")}
          </Link>
        ) : null}
      </Scroll>
    </SectionCard>
  );
}

function FlowGroup({ title, total, rows, label }: { title: string; total: number; rows: { key: string; name: string; amountPaise: number }[]; label: (key: string, fallback: string) => string }) {
  return (
    <>
      <AmountRow label={title} paise={total} strong />
      {rows.map((row) => (
        <AmountRow key={row.key} label={label(row.key, row.name)} paise={row.amountPaise} indent />
      ))}
    </>
  );
}

/** Journal lines carry the account code; the chart's codes map back to the stable key used for translated names. */
function accountKeyOf(code: string): string {
  return CHART.find((account) => account.code === code)?.key ?? code;
}
