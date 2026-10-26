import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { FindInvoiceForm, ReturnForm } from "@/components/sales/return-form";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { getReturnableInvoice } from "@/modules/sales";
import { requireSession } from "@/server/auth";
import { NotFoundError } from "@/server/errors";

export const metadata: Metadata = { title: "New return" };

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
        Returns
      </Link>
      {!invoice ? (
        <SectionCard title={invoiceId ? "Bill not found" : "Find the bill"} description={invoiceId ? "It may belong to a different shop. Search by its number." : undefined}>
          <FindInvoiceForm />
        </SectionCard>
      ) : invoice.status === "cancelled" ? (
        <SectionCard title={`${invoice.number} is cancelled`} description="Everything on a cancelled bill was already reversed, so there is nothing to return.">
          <Link href={`/billing/invoices/${invoice.id}`} className="text-sm font-semibold text-teal-strong hover:underline">
            View the bill
          </Link>
        </SectionCard>
      ) : (
        <>
          <section className="flex flex-col gap-1 rounded-2xl bg-panel p-5 text-panel-foreground sm:p-6">
            <p className="text-xs font-semibold tracking-wide text-panel-muted uppercase">Return against</p>
            <h2 className="text-xl font-bold">{invoice.number}</h2>
            <p className="text-sm text-panel-muted">
              {invoice.customer.name} · <Link href={`/billing/invoices/${invoice.id}`} className="underline">view bill</Link>
            </p>
          </section>
          <SectionCard title="What came back?" description="Enter quantities in each product's base unit, so part of a box can be returned. Amounts use the bill's own rates, discount and GST.">
            <ReturnForm invoice={invoice} />
          </SectionCard>
        </>
      )}
    </PageContainer>
  );
}
