import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Plus, ReceiptText } from "lucide-react";
import { Money } from "@/components/nexora/money";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { listInvoices } from "@/modules/sales";
import { requireSession } from "@/server/auth";
import { getLanguage, getT } from "@/server/i18n";
import { billDate, systemName } from "@/shared/i18n/labels";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.bills") };
}

type Search = PageProps<"/billing/invoices">["searchParams"];

export default function InvoicesPage({ searchParams }: PageProps<"/billing/invoices">) {
  return (
    <ProtectedPage permission="billing.view" title="Bills">
      <InvoiceList searchParams={searchParams} />
    </ProtectedPage>
  );
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

async function InvoiceList({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const q = one(params.q).trim();
  const date = one(params.date);
  const page = Math.max(1, Number.parseInt(one(params.page), 10) || 1);
  const result = await listInvoices(session, { q, date, page });
  const href = (target: number) => {
    const next = new URLSearchParams();
    if (q) next.set("q", q);
    if (date) next.set("date", date);
    if (target > 1) next.set("page", String(target));
    const query = next.toString();
    return query ? `/billing/invoices?${query}` : "/billing/invoices";
  };

  return (
    <PageContainer>
      <PageIntro
        description={t("bills.intro")}
        actions={
          <Link href="/billing" className={buttonVariants({ size: "touch" })}>
            <Plus aria-hidden="true" />
            {t("billing.newBill")}
          </Link>
        }
      />
      <SectionCard title={t("page.bills")} flush>
        <form role="search" action="/billing/invoices" className="grid grid-cols-2 gap-2 px-5 pb-3 sm:grid-cols-[minmax(0,1fr)_11rem_auto]">
          <label className="col-span-2 sm:col-span-1">
            <span className="sr-only">{t("bills.number")}</span>
            <Input name="q" defaultValue={q} placeholder={t("bills.numberPlaceholder")} className="h-11" />
          </label>
          <label>
            <span className="sr-only">{t("common.date")}</span>
            <Input type="date" name="date" defaultValue={date} className="h-11" />
          </label>
          <button type="submit" className={buttonVariants({ variant: "outline", size: "touch" })}>
            {t("common.search")}
          </button>
        </form>
        {result.items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 border-t border-border px-5 py-12 text-center">
            <ReceiptText className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="font-semibold text-foreground">{t(q || date ? "bills.noMatch" : "bills.none")}</p>
            <p className="max-w-sm text-sm text-muted-foreground">{t(q || date ? "bills.tryAnother" : "bills.noneHelp")}</p>
            <Link href={q || date ? "/billing/invoices" : "/billing"} className={buttonVariants({ variant: "outline", size: "touch" })}>
              {t(q || date ? "bills.clearSearch" : "bills.makeFirst")}
            </Link>
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-border border-t border-border">
            {result.items.map((invoice) => (
              <li key={invoice.id}>
                <Link href={`/billing/invoices/${invoice.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-muted/50">
                  <span className="min-w-0">
                    <span className="block font-semibold text-foreground">{invoice.number}</span>
                    <span className="block text-xs text-muted-foreground">
                      {billDate(invoice.businessDate, language)} · {systemName(invoice.customerName, language)}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <Money paise={invoice.totalPaise} className="font-semibold text-foreground" />
                    {invoice.status === "cancelled" ? (
                      <Badge variant="neutral">{t("status.cancelled")}</Badge>
                    ) : invoice.paidNowPaise >= invoice.totalPaise ? (
                      <Badge variant="success">{t("status.paid")}</Badge>
                    ) : invoice.paidNowPaise > 0 ? (
                      <Badge variant="warning">{t("status.partPaid")}</Badge>
                    ) : (
                      <Badge variant="info">{t("status.onCredit")}</Badge>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {result.page > 1 || result.hasMore ? (
          <nav aria-label={t("common.pages")} className="flex justify-between gap-2 border-t border-border px-5 pt-3">
            {result.page > 1 ? (
              <Link href={href(result.page - 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
                <ChevronLeft aria-hidden="true" />
                {t("common.newer")}
              </Link>
            ) : (
              <span />
            )}
            {result.hasMore ? (
              <Link href={href(result.page + 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
                {t("common.older")}
                <ChevronRight aria-hidden="true" />
              </Link>
            ) : null}
          </nav>
        ) : null}
      </SectionCard>
    </PageContainer>
  );
}
