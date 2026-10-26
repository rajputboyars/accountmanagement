import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, CircleCheck } from "lucide-react";
import { PrintButton } from "@/components/sales/invoice-actions";
import { Money } from "@/components/nexora/money";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { getCreditNote } from "@/modules/sales";
import { requireSession } from "@/server/auth";
import { NotFoundError } from "@/server/errors";
import { rupeesInWords } from "@/shared/invoice";
import { formatBasisPoints } from "@/shared/pricing-engine";

export const metadata: Metadata = { title: "Credit note" };

type Props = PageProps<"/billing/returns/[creditNoteId]">;

export default function CreditNotePage({ params, searchParams }: Props) {
  return (
    <ProtectedPage permission="billing.view" title="Credit note">
      <CreditNoteView params={params} searchParams={searchParams} />
    </ProtectedPage>
  );
}

const dateText = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
const SETTLEMENT: Record<string, string> = { ledger: "Adjusted against the customer's dues", cash: "Refunded in cash", upi: "Refunded by UPI", bank: "Refunded by bank transfer" };

async function CreditNoteView({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const [{ creditNoteId }, query] = await Promise.all([params, searchParams]);
  const session = await requireSession();
  const note = await getCreditNote(session, creditNoteId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!note) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title="Credit note not found" description="It may have been typed wrongly, or it belongs to a different shop.">
          <Link href="/billing/returns" className="text-sm font-semibold text-teal-strong hover:underline">
            Back to returns
          </Link>
        </SectionCard>
      </PageContainer>
    );
  }

  return (
    <PageContainer className="max-w-4xl print:max-w-none print:p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/billing/returns" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Returns
        </Link>
        <PrintButton />
      </div>
      {query.new === "1" ? (
        <p role="status" className="flex gap-2 rounded-xl bg-success-soft px-4 py-3 text-sm text-success print:hidden">
          <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          Credit note {note.number} saved. Stock and the customer&apos;s account are updated.
        </p>
      ) : null}

      <article className="flex flex-col gap-5 rounded-2xl border border-border bg-card p-5 sm:p-8 print:rounded-none print:border-0 print:p-0">
        <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:justify-between">
          <div>
            <p className="text-lg font-bold text-foreground">{note.shop.legalName ?? note.shop.name}</p>
            {note.shop.address ? <p className="text-sm text-muted-foreground">{note.shop.address}</p> : null}
            <p className="text-sm text-muted-foreground">{note.shop.gstin ? `GSTIN ${note.shop.gstin}` : "GSTIN not set"}</p>
          </div>
          <div className="sm:text-right">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Credit note</p>
            <p className="text-lg font-bold text-foreground">{note.number}</p>
            <p className="text-sm text-muted-foreground">{dateText(note.businessDate)}</p>
            <p className="text-sm text-muted-foreground">
              Against <Link href={`/billing/invoices/${note.invoiceId}`} className="underline print:no-underline">{note.invoiceNumber}</Link> of {note.invoiceDate ? dateText(note.invoiceDate) : ""}
            </p>
          </div>
        </header>

        <section className="text-sm">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Customer</p>
          <p className="font-semibold text-foreground">{note.customer.name}</p>
          {note.customer.gstin ? <p className="text-muted-foreground">GSTIN {note.customer.gstin}</p> : null}
          <p className="mt-1 text-muted-foreground">Reason: {note.reason}</p>
        </section>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-2 font-medium">Item</th>
                <th className="py-2 pr-2 text-right font-medium">Qty</th>
                <th className="py-2 pr-2 text-right font-medium">GST</th>
                <th className="py-2 text-right font-medium">Taxable</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {note.lines.map((line) => (
                <tr key={line.id}>
                  <td className="py-2 pr-2">
                    <p className="font-medium text-foreground">{line.productName}</p>
                    <p className="text-xs text-muted-foreground">{line.restock ? "Back to stock" : "Damaged, written off"}</p>
                  </td>
                  <td className="py-2 pr-2 text-right whitespace-nowrap tabular-nums">
                    {line.baseQty} {line.baseUnit}
                  </td>
                  <td className="py-2 pr-2 text-right text-muted-foreground">{formatBasisPoints(line.gstRateBp)}</td>
                  <td className="py-2 text-right">
                    <Money paise={line.taxablePaise} withPaise />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <dl className="flex flex-col gap-1 self-end text-sm sm:w-72">
          <Row label="Taxable value" paise={note.taxablePaise} />
          <Row label="CGST" paise={note.cgstPaise} />
          <Row label="SGST" paise={note.sgstPaise} />
          {note.roundOffPaise !== 0 ? <Row label="Round off" paise={note.roundOffPaise} /> : null}
          <div className="mt-1 flex items-baseline justify-between border-t border-border pt-2">
            <dt className="font-semibold text-foreground">Total</dt>
            <dd className="text-xl font-bold text-foreground">
              <Money paise={note.totalPaise} withPaise />
            </dd>
          </div>
          <p className="text-right text-xs text-muted-foreground">{rupeesInWords(note.totalPaise)}</p>
        </dl>

        <footer className="flex flex-col gap-1 border-t border-border pt-4 text-sm">
          <p className="text-foreground">{SETTLEMENT[note.settlement]}.</p>
          {note.balanceNowPaise !== null ? (
            <p className="text-xs text-muted-foreground print:hidden">
              {note.customer.name}&apos;s dues now: <Money paise={note.balanceNowPaise} withPaise />
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">Issued by {note.createdByName}.</p>
        </footer>
      </article>
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
