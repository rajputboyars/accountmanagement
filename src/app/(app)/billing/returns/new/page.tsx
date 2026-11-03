import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { FindInvoiceForm, ReturnForm } from "@/components/sales/return-form";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { getReturnableInvoice } from "@/modules/sales";
import { requireSession } from "@/server/auth";
import { getLanguage, getT } from "@/server/i18n";
import { systemName } from "@/shared/i18n/labels";
import { NotFoundError } from "@/server/errors";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.newReturn") };
}

export default function NewReturnPage({ searchParams }: PageProps<"/billing/returns/new">) {
  return (
    <ProtectedPage permission="billing.return" title="New return">
      <NewReturn searchParams={searchParams} />
    </ProtectedPage>
  );
}

async function NewReturn({ searchParams }: { searchParams: PageProps<"/billing/returns/new">["searchParams"] }) {
  const params = await searchParams;
  const invoiceId = String(params.invoice ?? "");
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const invoice = invoiceId
    ? await getReturnableInvoice(session, invoiceId).catch((error: unknown) => {
        if (error instanceof NotFoundError) return null;
        throw error;
      })
    : null;

  return (
    <PageContainer className="max-w-4xl">
      <Link href="/billing/returns" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("billing.returns")}
      </Link>
      {!invoice ? (
        <SectionCard title={t(invoiceId ? "bill.notFound" : "returns.findBill")} description={invoiceId ? t("returns.billNotFoundHelp") : undefined}>
          <FindInvoiceForm />
        </SectionCard>
      ) : invoice.status === "cancelled" ? (
        <SectionCard title={t("returns.isCancelled", { number: invoice.number })} description={t("returns.isCancelledHelp")}>
          <Link href={`/billing/invoices/${invoice.id}`} className="text-sm font-semibold text-teal-strong hover:underline">
            {t("returns.viewTheBill")}
          </Link>
        </SectionCard>
      ) : (
        <>
          <section className="flex flex-col gap-1 rounded-2xl bg-panel p-5 text-panel-foreground sm:p-6">
            <p className="text-xs font-semibold tracking-wide text-panel-muted uppercase">{t("returns.returnAgainst")}</p>
            <h2 className="text-xl font-bold">{invoice.number}</h2>
            <p className="text-sm text-panel-muted">
              {systemName(invoice.customer.name, language)} · <Link href={`/billing/invoices/${invoice.id}`} className="underline">{t("returns.viewBill")}</Link>
            </p>
          </section>
          <SectionCard title={t("returns.whatCameBack")} description={t("returns.whatCameBackHelp")}>
            <ReturnForm invoice={invoice} />
          </SectionCard>
        </>
      )}
    </PageContainer>
  );
}
