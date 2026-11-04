import type { Metadata } from "next";
import Link from "next/link";
import { Money } from "@/components/nexora/money";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { accountLabel, CompletenessNote } from "@/components/money/money-bits";
import { RangeFilter } from "@/components/reports/range-filter";
import { buttonVariants } from "@/components/ui/button";
import { moneyOverview } from "@/modules/accounting";
import { requireSession } from "@/server/auth";
import { getT } from "@/server/i18n";
import { indiaDate } from "@/shared/financial-year";
import { rangeLabel } from "@/shared/i18n/labels";
import { resolveRange } from "@/shared/report-range";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("money.title") };
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default function MoneyPage({ searchParams }: Props) {
  return (
    <ProtectedPage permission="profit.view" title="Money overview">
      <MoneyView searchParams={searchParams} />
    </ProtectedPage>
  );
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

async function MoneyView({ searchParams }: Pick<Props, "searchParams">) {
  const [query, session, t] = await Promise.all([searchParams, requireSession(), getT()]);
  const today = indiaDate();
  const range = resolveRange({ range: one(query.range) ?? "month", from: one(query.from), to: one(query.to) }, today);
  const overview = await moneyOverview(session, { from: range.from, to: range.to });

  if (!overview.active) {
    return (
      <PageContainer className="max-w-3xl">
        <SectionCard title={t("money.off.title")}>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">{t("money.off.body")}</p>
            <Link href="/reports/money/setup" className={buttonVariants({ size: "touch", className: "self-start" })}>
              {t("money.off.start")}
            </Link>
          </div>
        </SectionCard>
      </PageContainer>
    );
  }

  const setupOpen = overview.status.incompleteReasons.some((reason) => ["opening_missing", "opening_unverified", "clearing_not_zero"].includes(reason));
  const profit = overview.profit!;
  const figures = [
    ["money.sales", profit.salesPaise],
    ["money.cost", profit.costOfGoodsPaise],
    ["money.grossProfit", profit.grossProfitPaise],
    ["money.expenses", profit.expensesPaise],
    ["money.netProfit", profit.netProfitPaise],
  ] as const;
  return (
    <PageContainer>
      <PageIntro
        description={t("money.description")}
        actions={
          <>
            {setupOpen ? (
              <Link href="/reports/money/setup" className={buttonVariants({ variant: "outline", size: "touch" })}>
                {t("money.setupLink")}
              </Link>
            ) : null}
            <Link href="/reports/money/accountant/pl" className={buttonVariants({ variant: "outline", size: "touch" })}>
              {t("money.accountantLink")}
            </Link>
          </>
        }
      />
      <RangeFilter basePath="/reports/money" range={range} today={today} />
      <p className="text-xs text-muted-foreground">{t("money.coverage", { date: overview.status.coverageStartDate ?? "" })}</p>

      <SectionCard title={t("money.profit.title")} description={rangeLabel(t, range)}>
        <div className="flex flex-col gap-4">
          <CompletenessNote completeness={{ complete: overview.profitComplete, reasons: overview.profitReasons, coverageStartDate: overview.status.coverageStartDate }} t={t} />
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {figures.map(([key, value]) => (
              <div key={key} className="flex flex-col gap-1 rounded-xl bg-muted/40 p-3">
                <dt className="text-xs text-muted-foreground">{t(key)}</dt>
                <dd className="text-lg font-semibold">
                  <Money paise={value} withPaise />
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </SectionCard>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SectionCard title={t("money.cashBank")}>
          {overview.cashAndBank.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("money.nothing")}</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {overview.cashAndBank.map((row) => (
                <li key={row.key} className="flex items-baseline justify-between gap-3">
                  <span className="text-muted-foreground">{accountLabel(t, row.key, row.name)}</span>
                  <Money paise={row.amountPaise} withPaise />
                </li>
              ))}
              <li className="flex items-baseline justify-between gap-3 border-t border-border pt-2 font-semibold">
                <span>{t("common.total")}</span>
                <Money paise={overview.cashAndBankPaise} withPaise />
              </li>
            </ul>
          )}
        </SectionCard>
        <SectionCard title={t("money.owedToYou")}>
          <p className="text-2xl font-semibold">
            <Money paise={overview.owedToYouPaise} withPaise />
          </p>
        </SectionCard>
        <SectionCard title={t("money.youOwe")}>
          <p className="text-2xl font-semibold">
            <Money paise={overview.youOwePaise} withPaise />
          </p>
        </SectionCard>
        <SectionCard title={t("money.stockValue")}>
          <div className="flex flex-col gap-2">
            <p className="text-2xl font-semibold">
              <Money paise={overview.stockValuePaise} withPaise />
            </p>
            {overview.unvaluedProducts > 0 ? <p className="text-xs text-muted-foreground">{t("money.stockUnvalued", { count: overview.unvaluedProducts })}</p> : null}
            {overview.status.openGaps.some((gap) => gap.kind === "unvalued_opening_stock") ? (
              <Link href="/reports/money/fix" className="text-sm font-semibold text-teal-strong hover:underline">
                {t("money.fix.link")}
              </Link>
            ) : null}
          </div>
        </SectionCard>
      </div>
      {overview.partyMismatches > 0 ? <CompletenessNote completeness={{ complete: false, reasons: ["party_mismatch"], coverageStartDate: overview.status.coverageStartDate }} t={t} /> : null}
    </PageContainer>
  );
}
