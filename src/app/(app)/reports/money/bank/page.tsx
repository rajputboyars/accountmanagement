import { formatPaise } from "@/shared/money";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BankAccountForm } from "@/components/bank/bank-account-form";
import { Money } from "@/components/nexora/money";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { getAccountingStatus } from "@/modules/accounting";
import { bankOverview } from "@/modules/banking";
import { requireSession } from "@/server/auth";
import { getLanguage, getT } from "@/server/i18n";
import { indiaDate } from "@/shared/financial-year";
import { billDate } from "@/shared/i18n/labels";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("bank.title") };
}

export default function BankPage() {
  return (
    <ProtectedPage permission="settings.edit" title="Bank accounts">
      <BankView />
    </ProtectedPage>
  );
}

async function BankView() {
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const status = await getAccountingStatus(session);
  if (!status.active) {
    return (
      <PageContainer className="max-w-3xl">
        <SectionCard title={t("bank.off.title")}>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">{t("bank.off.body")}</p>
            <Link href="/reports/money/setup" className={buttonVariants({ size: "touch", className: "self-start" })}>
              {t("money.off.start")}
            </Link>
          </div>
        </SectionCard>
      </PageContainer>
    );
  }
  const accounts = await bankOverview(session);
  return (
    <PageContainer className="max-w-5xl">
      <Link href="/reports/money" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("money.title")}
      </Link>
      <PageIntro description={t("bank.intro")} />
      {accounts.length === 0 ? (
        <SectionCard title={t("bank.none.title")}>
          <p className="text-sm text-muted-foreground">{t("bank.none.body")}</p>
        </SectionCard>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {accounts.map((account) => (
            <li key={account.id} className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-foreground">
                  {account.name}
                  {account.last4 ? <span className="ml-2 text-sm font-normal text-muted-foreground">••{account.last4}</span> : null}
                </h2>
                {!account.isActive ? <Badge variant="neutral">{t("bank.off.badge")}</Badge> : account.unmatchedLines > 0 ? <Badge variant="warning">{t("bank.toSort", { count: account.unmatchedLines })}</Badge> : <Badge variant="success">{t("bank.allSorted")}</Badge>}
              </div>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">{t("bank.inBooks")}</dt>
                  <dd className="text-lg font-semibold">
                    <Money paise={account.bookBalancePaise} withPaise />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t("bank.onStatement")}</dt>
                  <dd className="text-lg font-semibold">{account.lastStatementBalancePaise === null ? "—" : <Money paise={account.lastStatementBalancePaise} withPaise />}</dd>
                  {account.lastStatementDate ? <dd className="text-xs text-muted-foreground">{billDate(account.lastStatementDate, language)}</dd> : null}
                </div>
              </dl>
              {account.isActive && account.bookBalancePaise < 0 ? (
                <p role="status" data-testid="bank-negative" className="rounded-lg bg-amber-soft px-3 py-2 text-xs font-medium text-amber-ink">
                  {t("bank.negative", { name: account.name, amount: formatPaise(-account.bookBalancePaise, { withPaise: true }) })}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">{account.reconciledThrough ? t("bank.reconciledThrough", { date: billDate(account.reconciledThrough, language) }) : t("bank.notReconciled")}</p>
              <Link href={`/reports/money/bank/${account.id}`} className={buttonVariants({ size: "touch", className: "self-start" })}>
                {t("bank.open")}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <SectionCard title={accounts.length === 0 ? t("bank.add.titleFirst") : t("bank.add.title")}>
        <BankAccountForm today={indiaDate()} first={accounts.length === 0} />
      </SectionCard>
    </PageContainer>
  );
}
