import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PrintButton } from "@/components/sales/invoice-actions";
import { Money } from "@/components/nexora/money";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { getSupplierStatement } from "@/modules/reporting";
import { requireSession } from "@/server/auth";
import { getLanguage, getT } from "@/server/i18n";
import { billDate, statementLabel } from "@/shared/i18n/labels";
import { NotFoundError } from "@/server/errors";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.supplierStatement") };
}

type Props = PageProps<"/suppliers/[supplierId]/statement">;

export default function SupplierStatementPage({ params }: Props) {
  return (
    <ProtectedPage permission="purchases.view" title="Supplier statement">
      <Statement params={params} />
    </ProtectedPage>
  );
}


async function Statement({ params }: Pick<Props, "params">) {
  const { supplierId } = await params;
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const dateText = (value: string) => billDate(value, language);
  const data = await getSupplierStatement(await requireSession(), supplierId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!data) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title={t("suppliers.notFound")}>
          <Link href="/suppliers" className="text-sm font-semibold text-teal-strong hover:underline">
            {t("suppliers.back")}
          </Link>
        </SectionCard>
      </PageContainer>
    );
  }
  return (
    <PageContainer className="max-w-4xl print:max-w-none print:p-0">
      <div className="flex justify-between gap-3 print:hidden">
        <Link href={`/suppliers/${data.supplier.id}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden="true" />
          {data.supplier.name}
        </Link>
        <PrintButton />
      </div>
      <article className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-5 text-sm sm:p-8 print:rounded-none print:border-0 print:p-0">
        <header className="flex flex-col gap-1 border-b border-border pb-4 sm:flex-row sm:justify-between">
          <p className="text-lg font-bold text-foreground">{data.shop.legalName ?? data.shop.name}</p>
          <div className="sm:text-right">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("suppliers.statementOf", { date: dateText(data.asOf) })}</p>
            <p className="font-semibold text-foreground">{data.supplier.name}</p>
          </div>
        </header>
        <div className="overflow-x-auto print:overflow-visible">
        <table className="stack-table w-full min-w-[30rem] print:min-w-0">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-1.5 font-medium">{t("statement.date")}</th>
              <th className="py-1.5 font-medium">{t("statement.entry")}</th>
              <th className="py-1.5 text-right font-medium">{t("suppliers.bought")}</th>
              <th className="py-1.5 text-right font-medium">{t("suppliers.paid")}</th>
              <th className="py-1.5 text-right font-medium">{t("suppliers.owe")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.statement.map((line) => (
              <tr key={line.id}>
                <td data-label={t("statement.date")} className="py-1.5 whitespace-nowrap">{dateText(line.entryDate)}</td>
                <td data-title>{statementLabel(line.description, language)}</td>
                <td data-label={t("suppliers.bought")} className="text-right">{line.creditPaise ? <Money paise={line.creditPaise} withPaise /> : ""}</td>
                <td data-label={t("suppliers.paid")} className="text-right">{line.debitPaise ? <Money paise={line.debitPaise} withPaise /> : ""}</td>
                <td data-key data-label={t("suppliers.owe")} className="text-right">
                  <Money paise={line.owedAfterPaise} withPaise />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {data.ageing.open.length > 0 ? (
          <div>
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("suppliers.unpaidOldest")}</p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {data.ageing.open.map((item) => (
                <li key={item.id} className="flex justify-between gap-3">
                  <span>
                    {statementLabel(item.label, language)} · {t("suppliers.dueOn", { date: dateText(item.dueDate) })}
                    {item.daysPastDue ? ` · ${t("suppliers.daysLate", { days: item.daysPastDue })}` : ""}
                  </span>
                  <Money paise={item.remainingPaise} withPaise />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="self-end text-base font-bold text-foreground">
          {t("suppliers.owedTotal")}<Money paise={Math.max(data.owedPaise, 0)} withPaise />
        </p>
      </article>
    </PageContainer>
  );
}
