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

export const metadata: Metadata = { title: "Bills" };

type Search = PageProps<"/billing/invoices">["searchParams"];

export default function InvoicesPage({ searchParams }: PageProps<"/billing/invoices">) {
  return (
    <ProtectedPage permission="billing.view" title="Bills">
      <InvoiceList searchParams={searchParams} />
    </ProtectedPage>
  );
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";
const dateText = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));

async function InvoiceList({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const session = await requireSession();
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
        description="Every bill, newest first. Cancelled bills stay listed; nothing is deleted."
        actions={
          <Link href="/billing" className={buttonVariants({ size: "touch" })}>
            <Plus aria-hidden="true" />
            New bill
          </Link>
        }
      />
      <SectionCard title="Bills" flush>
        <form role="search" action="/billing/invoices" className="grid grid-cols-2 gap-2 px-5 pb-3 sm:grid-cols-[minmax(0,1fr)_11rem_auto]">
          <label className="col-span-2 sm:col-span-1">
            <span className="sr-only">Bill number</span>
            <Input name="q" defaultValue={q} placeholder="Bill number, e.g. 00012" className="h-11" />
          </label>
          <label>
            <span className="sr-only">Date</span>
            <Input type="date" name="date" defaultValue={date} className="h-11" />
          </label>
          <button type="submit" className={buttonVariants({ variant: "outline", size: "touch" })}>
            Search
          </button>
        </form>
        {result.items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 border-t border-border px-5 py-12 text-center">
            <ReceiptText className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="font-semibold text-foreground">{q || date ? "No bills match" : "No bills yet"}</p>
            <p className="max-w-sm text-sm text-muted-foreground">{q || date ? "Try another bill number or date." : "Every bill you save shows up here, newest first, so you can print, return or cancel it later."}</p>
            <Link href={q || date ? "/billing/invoices" : "/billing"} className={buttonVariants({ variant: "outline", size: "touch" })}>
              {q || date ? "Clear search" : "Make the first bill"}
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
                      {dateText(invoice.businessDate)} · {invoice.customerName}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <Money paise={invoice.totalPaise} className="font-semibold text-foreground" />
                    {invoice.status === "cancelled" ? (
                      <Badge variant="neutral">Cancelled</Badge>
                    ) : invoice.paidNowPaise >= invoice.totalPaise ? (
                      <Badge variant="success">Paid</Badge>
                    ) : invoice.paidNowPaise > 0 ? (
                      <Badge variant="warning">Part paid</Badge>
                    ) : (
                      <Badge variant="info">On credit</Badge>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {result.page > 1 || result.hasMore ? (
          <nav aria-label="Pages" className="flex justify-between gap-2 border-t border-border px-5 pt-3">
            {result.page > 1 ? (
              <Link href={href(result.page - 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
                <ChevronLeft aria-hidden="true" />
                Newer
              </Link>
            ) : (
              <span />
            )}
            {result.hasMore ? (
              <Link href={href(result.page + 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
                Older
                <ChevronRight aria-hidden="true" />
              </Link>
            ) : null}
          </nav>
        ) : null}
      </SectionCard>
    </PageContainer>
  );
}
