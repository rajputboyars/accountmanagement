import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ReturnForm } from "@/components/sales/return-form";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { listBankChoices } from "@/modules/accounting";
import { getReturnableInvoice, searchReturnableInvoices, type ReturnSearchRow } from "@/modules/sales";
import { Input } from "@/components/ui/input";
import { buttonVariants } from "@/components/ui/button";
import { Money } from "@/components/nexora/money";
import { Search } from "lucide-react";
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
    <ProtectedPage permission={["billing.return", "billing.return.limited"]} title="New return">
      <NewReturn searchParams={searchParams} />
    </ProtectedPage>
  );
}

async function NewReturn({ searchParams }: { searchParams: PageProps<"/billing/returns/new">["searchParams"] }) {
  const params = await searchParams;
  const invoiceId = String(params.invoice ?? "");
  const one = (value: string | string[] | undefined) => String(Array.isArray(value) ? value[0] : (value ?? "")).trim();
  const filters = { customer: one(params.customer), number: one(params.number), product: one(params.product), from: one(params.from), to: one(params.to) };
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const invoice = invoiceId
    ? await getReturnableInvoice(session, invoiceId).catch((error: unknown) => {
        if (error instanceof NotFoundError) return null;
        throw error;
      })
    : null;

  const searching = Object.values(filters).some(Boolean);
  const results: ReturnSearchRow[] | null = !invoice && searching ? await searchReturnableInvoices(session, filters) : null;

  return (
    <PageContainer className="max-w-4xl">
      <Link href="/billing/returns" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("billing.returns")}
      </Link>
      {!invoice ? (
        <>
          <SectionCard title={t(invoiceId ? "bill.notFound" : "returns.findBill")} description={invoiceId ? t("returns.billNotFoundHelp") : t("returns.searchHelp")}>
            <form action="/billing/returns/new" className="grid gap-3 sm:grid-cols-2" data-testid="return-search">
              <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
                {t("returns.searchCustomer")}
                <Input name="customer" defaultValue={filters.customer} className="h-11" autoComplete="off" />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
                {t("returns.billNumber")}
                <Input name="number" defaultValue={filters.number} placeholder={t("returns.billNumberPlaceholder")} className="h-11" autoComplete="off" />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
                {t("returns.searchProduct")}
                <Input name="product" defaultValue={filters.product} className="h-11" autoComplete="off" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
                  {t("returns.searchFrom")}
                  <Input type="date" name="from" defaultValue={filters.from} className="h-11" />
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
                  {t("returns.searchTo")}
                  <Input type="date" name="to" defaultValue={filters.to} className="h-11" />
                </label>
              </div>
              <div>
                <button type="submit" className={buttonVariants({ size: "touch" })}>
                  <Search aria-hidden="true" />
                  {t("returns.findBillButton")}
                </button>
              </div>
            </form>
          </SectionCard>
          {results ? (
            <SectionCard title={t("returns.searchResults")} description={results.length === 0 ? t("returns.searchNone") : undefined} flush>
              <ul className="flex flex-col divide-y divide-border text-sm" data-testid="return-results">
                {results.map((row) => (
                  <li key={row.id}>
                    <Link href={`/billing/returns/new?invoice=${row.id}`} className="flex flex-col gap-1 px-5 py-3 hover:bg-muted/50">
                      <span className="flex items-center justify-between gap-3">
                        <span className="font-semibold text-foreground">{row.number} · {systemName(row.customerName, language)}</span>
                        <span className="shrink-0 tabular-nums"><Money paise={row.totalPaise} withPaise /></span>
                      </span>
                      <span className="text-xs text-muted-foreground">{row.businessDate} · {row.items.map((item) => `${systemName(item.name, language)} (${t("returns.canReturn", { qty: item.remaining, unit: item.unit })})`).join(", ")}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}
        </>
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
            <ReturnForm invoice={invoice} bankAccounts={await listBankChoices(session).catch(() => [])} />
          </SectionCard>
        </>
      )}
    </PageContainer>
  );
}
