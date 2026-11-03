import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PrintButton } from "@/components/sales/invoice-actions";
import { Money } from "@/components/nexora/money";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { getCustomerAccount } from "@/modules/reporting";
import { requireSession } from "@/server/auth";
import { getLanguage, getT } from "@/server/i18n";
import { billDate, statementLabel } from "@/shared/i18n/labels";
import { ConflictError, NotFoundError } from "@/server/errors";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.statement") };
}

type Props = PageProps<"/customers/[customerId]/statement">;

export default function StatementPage({ params, searchParams }: Props) {
  return (
    <ProtectedPage permission="customers.view" title="Statement">
      <Statement params={params} searchParams={searchParams} />
    </ProtectedPage>
  );
}


async function Statement({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const [{ customerId }, query] = await Promise.all([params, searchParams]);
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const dateText = (value: string) => billDate(value, language);
  const account = await getCustomerAccount(await requireSession(), customerId, { from: String(query.from ?? ""), to: String(query.to ?? "") }).catch((error: unknown) => {
    if (error instanceof NotFoundError || error instanceof ConflictError) return null;
    throw error;
  });
  if (!account) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title={t("customers.notFound")}>
          <Link href="/customers" className="text-sm font-semibold text-teal-strong hover:underline">
            {t("customers.back")}
          </Link>
        </SectionCard>
      </PageContainer>
    );
  }
  const { customer, shop } = account;
  return (
    <PageContainer className="max-w-4xl print:max-w-none print:p-0">
      <div className="flex justify-between gap-3 print:hidden">
        <Link href={`/customers/${customer.id}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden="true" />
          {customer.name}
        </Link>
        <PrintButton />
      </div>
      <article className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-5 text-sm sm:p-8 print:rounded-none print:border-0 print:p-0">
        <header className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:justify-between">
          <div>
            <p className="text-lg font-bold text-foreground">{shop.legalName ?? shop.name}</p>
            {shop.gstin ? <p className="text-muted-foreground">{t("common.gstinValue", { gstin: shop.gstin })}</p> : null}
          </div>
          <div className="sm:text-right">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("statement.of")}</p>
            <p className="font-semibold text-foreground">{customer.name}</p>
            <p className="text-muted-foreground">
              {account.from ? dateText(account.from) : t("statement.fromStart")} – {dateText(account.to ?? account.asOf)}
            </p>
          </div>
        </header>
        <div className="overflow-x-auto print:overflow-visible">
        <table className="stack-table w-full min-w-[30rem] print:min-w-0">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-1.5 font-medium">{t("statement.date")}</th>
              <th className="py-1.5 font-medium">{t("statement.entry")}</th>
              <th className="py-1.5 text-right font-medium">{t("statement.debit")}</th>
              <th className="py-1.5 text-right font-medium">{t("statement.credit")}</th>
              <th className="py-1.5 text-right font-medium">{t("statement.balance")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {account.from ? (
              <tr>
                <td data-label={t("statement.date")} className="py-1.5">{dateText(account.from)}</td>
                <td data-title colSpan={3}>{t("statement.broughtForward")}</td>
                <td data-key data-label={t("statement.balance")} className="text-right">
                  <Money paise={account.broughtForwardPaise} withPaise />
                </td>
              </tr>
            ) : null}
            {account.statement.map((line) => (
              <tr key={line.id}>
                <td data-label={t("statement.date")} className="py-1.5 whitespace-nowrap">{dateText(line.entryDate)}</td>
                <td data-title>{statementLabel(line.description, language)}</td>
                <td data-label={t("statement.debit")} className="text-right">{line.debitPaise ? <Money paise={line.debitPaise} withPaise /> : ""}</td>
                <td data-label={t("statement.credit")} className="text-right">{line.creditPaise ? <Money paise={line.creditPaise} withPaise /> : ""}</td>
                <td data-key data-label={t("statement.balance")} className="text-right">
                  <Money paise={line.balancePaise} withPaise />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <p className="self-end text-base font-bold text-foreground">
          {t(account.balancePaise < 0 ? "statement.advanceLabel" : "statement.outstandingLabel")}
          <Money paise={Math.abs(account.balancePaise)} withPaise />
        </p>
      </article>
    </PageContainer>
  );
}
