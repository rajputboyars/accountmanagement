import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, CircleCheck, Plus, Undo2 } from "lucide-react";
import { CancelInvoice, PrintButton } from "@/components/sales/invoice-actions";
import { Money } from "@/components/nexora/money";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { getInvoice } from "@/modules/sales";
import { requireSession } from "@/server/auth";
import { NotFoundError } from "@/server/errors";
import { rupeesInWords } from "@/shared/invoice";
import { formatBasisPoints } from "@/shared/pricing-engine";

export const metadata: Metadata = { title: "Bill" };

type Props = PageProps<"/billing/invoices/[invoiceId]">;

export default function InvoicePage({ params, searchParams }: Props) {
  return (
    <ProtectedPage permission="billing.view" title="Bill">
      <InvoiceView params={params} searchParams={searchParams} />
    </ProtectedPage>
  );
}

const METHOD_LABEL: Record<string, string> = { cash: "Cash", upi: "UPI", card: "Card", bank: "Bank", cheque: "Cheque" };
const dateText = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));

async function InvoiceView({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const [{ invoiceId }, query] = await Promise.all([params, searchParams]);
  const session = await requireSession();
  const invoice = await getInvoice(session, invoiceId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!invoice) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title="Bill not found" description="It may have been typed wrongly, or it belongs to a different shop.">
          <Link href="/billing/invoices" className="text-sm font-semibold text-teal-strong hover:underline">
            Back to bills
          </Link>
        </SectionCard>
      </PageContainer>
    );
  }

  const cancelled = invoice.status === "cancelled";
  const received = invoice.payments.filter((payment) => payment.direction === "in");
  const refunded = invoice.payments.filter((payment) => payment.direction === "out");
  const creditPaise = invoice.totalPaise - invoice.paidNowPaise;
  const rateGroups = [...new Set(invoice.lines.map((line) => line.gstRateBp))].sort((a, b) => a - b).map((rate) => {
    const lines = invoice.lines.filter((line) => line.gstRateBp === rate);
    return { rate, taxable: lines.reduce((sum, line) => sum + line.taxablePaise, 0), cgst: lines.reduce((sum, line) => sum + line.cgstPaise, 0), sgst: lines.reduce((sum, line) => sum + line.sgstPaise, 0) };
  });

  return (
    <PageContainer className="max-w-4xl print:max-w-none print:p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/billing/invoices" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Bills
        </Link>
        <div className="flex flex-wrap gap-2">
          <PrintButton />
          <Link href="/billing" className={buttonVariants({ size: "touch" })}>
            <Plus aria-hidden="true" />
            New bill
          </Link>
        </div>
      </div>

      {query.new === "1" ? (
        <p role="status" className="flex gap-2 rounded-xl bg-success-soft px-4 py-3 text-sm text-success print:hidden">
          <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          Bill {invoice.number} saved. Stock and the customer&apos;s dues are updated.
        </p>
      ) : null}
      {cancelled ? (
        <p role="status" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
          Cancelled by {invoice.cancelledByName}: {invoice.cancelReason}
        </p>
      ) : null}

      <article className="flex flex-col gap-5 rounded-2xl border border-border bg-card p-5 sm:p-8 print:rounded-none print:border-0 print:p-0">
        <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:justify-between">
          <div>
            <p className="text-lg font-bold text-foreground">{invoice.shop.legalName ?? invoice.shop.name}</p>
            {invoice.shop.address ? <p className="text-sm text-muted-foreground">{invoice.shop.address}</p> : null}
            <p className="text-sm text-muted-foreground">
              {invoice.shop.gstin ? `GSTIN ${invoice.shop.gstin}` : "GSTIN not set"} · State code {invoice.shop.stateCode}
              {invoice.shop.phone ? ` · ${invoice.shop.phone}` : ""}
            </p>
          </div>
          <div className="sm:text-right">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Tax invoice</p>
            <p className="text-lg font-bold text-foreground">{invoice.number}</p>
            <p className="text-sm text-muted-foreground">{dateText(invoice.businessDate)}</p>
            <div className="mt-1 flex gap-1.5 sm:justify-end">
              <Badge variant={invoice.priceList === "wholesale" ? "info" : "neutral"}>{invoice.priceList === "wholesale" ? "Wholesale" : "Retail"}</Badge>
              {cancelled ? <Badge variant="danger">Cancelled</Badge> : null}
            </div>
          </div>
        </header>

        <section aria-label="Billed to" className="text-sm">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Billed to</p>
          <p className="font-semibold text-foreground">{invoice.customer.name}</p>
          {invoice.customer.phone ? <p className="text-muted-foreground">{invoice.customer.phone}</p> : null}
          {invoice.customer.gstin ? <p className="text-muted-foreground">GSTIN {invoice.customer.gstin}</p> : null}
        </section>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-2 font-medium">#</th>
                <th className="py-2 pr-2 font-medium">Item</th>
                <th className="py-2 pr-2 text-right font-medium">Qty</th>
                <th className="py-2 pr-2 text-right font-medium">Rate</th>
                <th className="py-2 pr-2 text-right font-medium">GST</th>
                <th className="py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {invoice.lines.map((line) => (
                <tr key={line.id}>
                  <td className="py-2 pr-2 align-top text-muted-foreground">{line.lineNo}</td>
                  <td className="py-2 pr-2 align-top">
                    <p className="font-medium text-foreground">{line.productName}</p>
                    <p className="text-xs text-muted-foreground">{line.rateReason}</p>
                  </td>
                  <td className="py-2 pr-2 text-right align-top whitespace-nowrap tabular-nums">
                    {line.qty} {line.unit}
                    {line.unit !== line.baseUnit ? <span className="block text-xs text-muted-foreground">({line.baseQty} {line.baseUnit})</span> : null}
                  </td>
                  <td className="py-2 pr-2 text-right align-top">
                    <Money paise={line.ratePaise} withPaise />
                  </td>
                  <td className="py-2 pr-2 text-right align-top text-muted-foreground">{formatBasisPoints(line.gstRateBp)}</td>
                  <td className="py-2 text-right align-top">
                    <Money paise={line.linePaise} withPaise />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="text-sm">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Tax summary</p>
            <table className="mt-1 w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 font-medium">GST</th>
                  <th className="py-1 text-right font-medium">Taxable</th>
                  <th className="py-1 text-right font-medium">CGST</th>
                  <th className="py-1 text-right font-medium">SGST</th>
                </tr>
              </thead>
              <tbody>
                {rateGroups.map((group) => (
                  <tr key={group.rate}>
                    <td className="py-1">{formatBasisPoints(group.rate)}</td>
                    <td className="py-1 text-right">
                      <Money paise={group.taxable} withPaise />
                    </td>
                    <td className="py-1 text-right">
                      <Money paise={group.cgst} withPaise />
                    </td>
                    <td className="py-1 text-right">
                      <Money paise={group.sgst} withPaise />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="flex flex-col gap-1 text-sm">
            <Row label="Subtotal" paise={invoice.subtotalPaise} />
            {invoice.discountPaise > 0 ? <Row label={`Discount ${formatBasisPoints(invoice.discountBp)}`} paise={-invoice.discountPaise} /> : null}
            <Row label="Taxable value" paise={invoice.taxablePaise} />
            <Row label="CGST" paise={invoice.cgstPaise} />
            <Row label="SGST" paise={invoice.sgstPaise} />
            {invoice.roundOffPaise !== 0 ? <Row label="Round off" paise={invoice.roundOffPaise} /> : null}
            <div className="mt-1 flex items-baseline justify-between border-t border-border pt-2">
              <dt className="font-semibold text-foreground">Total</dt>
              <dd className="text-xl font-bold text-foreground">
                <Money paise={invoice.totalPaise} withPaise />
              </dd>
            </div>
            <p className="text-right text-xs text-muted-foreground">{rupeesInWords(invoice.totalPaise)}</p>
          </dl>
        </div>

        <section aria-label="Payment" className="flex flex-col gap-1 border-t border-border pt-4 text-sm">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Payment</p>
          {received.length === 0 ? <p className="text-foreground">Full amount on credit.</p> : null}
          {received.map((payment) => (
            <Row key={payment.id} label={`${METHOD_LABEL[payment.method] ?? payment.method}${payment.status === "reversed" ? " (refunded)" : ""}`} paise={payment.amountPaise} />
          ))}
          {creditPaise > 0 && !cancelled ? <Row label="Added to customer's dues" paise={creditPaise} /> : null}
          {refunded.map((payment) => (
            <Row key={payment.id} label={`Refund · ${METHOD_LABEL[payment.method] ?? payment.method}`} paise={-payment.amountPaise} />
          ))}
          {invoice.balanceNowPaise !== null ? (
            <p className="mt-1 text-xs text-muted-foreground print:hidden">
              {invoice.customer.name}&apos;s dues now: <Money paise={invoice.balanceNowPaise} withPaise />
            </p>
          ) : null}
        </section>

        <footer className="text-xs text-muted-foreground">
          Billed by {invoice.createdByName}. Prices exclude GST; tax shown separately. This is a computer-generated invoice.
        </footer>
      </article>

      {invoice.creditNotes.length > 0 ? (
        <SectionCard title="Returns on this bill" className="print:hidden">
          <ul className="flex flex-col divide-y divide-border text-sm">
            {invoice.creditNotes.map((note) => (
              <li key={note.id} className="flex justify-between gap-3 py-2 first:pt-0">
                <Link href={`/billing/returns/${note.id}`} className="font-semibold text-teal-strong hover:underline">
                  {note.number}
                </Link>
                <span className="text-muted-foreground">
                  {dateText(note.businessDate)} · <Money paise={note.totalPaise} withPaise />
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {invoice.canCancel || invoice.canReturn ? (
        <div className="flex flex-wrap items-start gap-2 print:hidden">
          {invoice.canReturn ? (
            <Link href={`/billing/returns/new?invoice=${invoice.id}`} className={buttonVariants({ variant: "outline", size: "touch" })}>
              <Undo2 aria-hidden="true" />
              Return items
            </Link>
          ) : null}
          {invoice.canCancel ? <CancelInvoice invoiceId={invoice.id} number={invoice.number} /> : null}
        </div>
      ) : null}
    </PageContainer>
  );
}

function Row({ label, paise }: { label: string; paise: number }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground">
        <Money paise={paise} withPaise />
      </dd>
    </div>
  );
}
