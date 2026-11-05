import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BankLines } from "@/components/bank/bank-lines";
import { Money } from "@/components/nexora/money";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { buttonVariants } from "@/components/ui/button";
import { getBankAccount } from "@/modules/accounting";
import { bankOverview, bankWorkbench, listStatements } from "@/modules/banking";
import { listActiveCustomers, listShopSuppliers } from "@/modules/parties";
import { requireSession } from "@/server/auth";
import { NotFoundError } from "@/server/errors";
import { getLanguage, getT } from "@/server/i18n";
import { billDate } from "@/shared/i18n/labels";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("bank.title") };
}

type Props = { params: Promise<{ accountId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default function BankAccountPage(props: Props) {
  return (
    <ProtectedPage permission="settings.edit" title="Bank account">
      <BankAccountView {...props} />
    </ProtectedPage>
  );
}

async function BankAccountView({ params, searchParams }: Props) {
  const [{ accountId }, query] = await Promise.all([params, searchParams]);
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const account = await getBankAccount(session, accountId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!account) return null;
  const showAll = (Array.isArray(query.show) ? query.show[0] : query.show) === "all";
  const [bench, statements, customers, suppliers, overview] = await Promise.all([bankWorkbench(session, account.id, showAll ? "all" : "open"), listStatements(session, account.id), listActiveCustomers(session.shopId), listShopSuppliers(session.shopId), bankOverview(session)]);
  const open = bench.lines.filter((line) => line.status === "unmatched").length;
  const waiting = bench.clearingItems.reduce((sum, item) => sum + item.signedPaise, 0);
  const latestBalance = overview.find((row) => row.id === account.id)?.lastStatementBalancePaise ?? null;
  const items = [...bench.bankItems, ...bench.clearingItems].map((item) => ({ journalLineId: item.journalLineId, signedPaise: item.signedPaise, date: item.date, label: item.label, partyName: item.partyName, reference: item.reference, method: item.method, clearing: item.clearing }));
  return (
    <PageContainer className="max-w-5xl">
      <Link href="/reports/money/bank" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("bank.title")}
      </Link>
      <section className="flex flex-col gap-4 rounded-2xl bg-panel p-5 text-panel-foreground sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-bold">
            {account.name}
            {account.last4 ? <span className="ml-2 text-base font-normal text-panel-muted">••{account.last4}</span> : null}
          </h2>
          <div className="flex flex-wrap gap-2">
            <Link href={`/reports/money/bank/${account.id}/import`} className={buttonVariants({ size: "touch" })}>
              {t("bank.importLink")}
            </Link>
            <Link href={`/reports/money/bank/${account.id}/reconcile`} className={buttonVariants({ variant: "outline", size: "touch", className: "border-panel-muted/40 bg-transparent text-panel-foreground hover:bg-white/10" })}>
              {t("bank.reconcileLink")}
            </Link>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-panel-muted">{t("bank.inBooks")}</dt>
            <dd className="text-lg font-semibold">
              <Money paise={account.bookBalancePaise} withPaise />
            </dd>
          </div>
          <div>
            <dt className="text-panel-muted">{t("bank.onStatement")}</dt>
            <dd className="text-lg font-semibold">{latestBalance !== null ? <Money paise={latestBalance} withPaise /> : "—"}</dd>
          </div>
          <div>
            <dt className="text-panel-muted">{t("bank.toSortLabel")}</dt>
            <dd className="text-lg font-semibold">{open}</dd>
          </div>
          <div>
            <dt className="text-panel-muted">{t("bank.waiting")}</dt>
            <dd className="text-lg font-semibold">
              <Money paise={waiting} withPaise />
            </dd>
          </div>
        </dl>
        <p className="text-xs text-panel-muted">{t("bank.waitingHelp")}</p>
      </section>

      <SectionCard
        title={showAll ? t("bank.allLines") : t("bank.toSortTitle")}
        description={showAll ? undefined : t("bank.toSortHelp")}
        action={
          <Link href={showAll ? `/reports/money/bank/${account.id}` : `/reports/money/bank/${account.id}?show=all`} className="text-sm font-semibold text-teal-strong hover:underline">
            {showAll ? t("bank.showOpen") : t("bank.showAll")}
          </Link>
        }
      >
        {bench.lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">{statements.length === 0 ? t("bank.noStatements") : t("bank.nothingToSort")}</p>
        ) : (
          <BankLines
            bankAccountId={account.id}
            lines={bench.lines}
            items={items}
            suggestions={bench.suggestions.map((suggestion) => ({ lineId: suggestion.lineId, kind: suggestion.kind, itemIds: suggestion.itemIds, feePaise: suggestion.feePaise, grossPaise: suggestion.grossPaise }))}
            customers={customers.map((customer) => ({ id: customer.id, name: customer.name }))}
            suppliers={suppliers.filter((supplier) => supplier.isActive).map((supplier) => ({ id: supplier.id, name: supplier.name }))}
            finalizedThrough={bench.finalizedThrough}
          />
        )}
        {bench.moreLines ? <p className="mt-3 text-xs text-muted-foreground">{t("bank.moreLines")}</p> : null}
      </SectionCard>

      {statements.length > 0 ? (
        <SectionCard title={t("bank.statements")}>
          <ul className="flex flex-col divide-y divide-border text-sm">
            {statements.map((statement) => (
              <li key={statement.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span className="font-medium text-foreground">{statement.fileName}</span>
                <span className="text-xs text-muted-foreground">
                  {statement.fromDate && statement.toDate ? `${billDate(statement.fromDate, language)} – ${billDate(statement.toDate, language)} · ` : ""}
                  {t("bank.statementCounts", { total: statement.lineCount, imported: statement.newLineCount })}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </PageContainer>
  );
}
