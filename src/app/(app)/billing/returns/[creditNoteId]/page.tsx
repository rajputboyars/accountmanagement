import type { Metadata } from "next";
import Link from "next/link";
import { stateTaxLabel } from "@/shared/gst";
import { ArrowLeft, CircleCheck } from "lucide-react";
import { PrintButton } from "@/components/sales/invoice-actions";
import { Money } from "@/components/nexora/money";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { getCreditNote } from "@/modules/sales";
import { requireSession } from "@/server/auth";
import { getLanguage, getT } from "@/server/i18n";
import { billDate, systemName } from "@/shared/i18n/labels";
import type { MessageKey } from "@/shared/i18n";
import { NotFoundError } from "@/server/errors";
import { amountInWords } from "@/shared/i18n/amount-words";
import { formatBasisPoints } from "@/shared/pricing-engine";
import { HelpHint } from "@/components/nexora/help-hint";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.creditNote") };
}

type Props = PageProps<"/billing/returns/[creditNoteId]">;

export default function CreditNotePage({ params, searchParams }: Props) {
  return (
    <ProtectedPage permission="billing.view" title="Credit note">
      <CreditNoteView params={params} searchParams={searchParams} />
    </ProtectedPage>
  );
}

const SETTLEMENT: Record<string, MessageKey> = { ledger: "note.settled.ledger", cash: "note.settled.cash", upi: "note.settled.upi", bank: "note.settled.bank" };

async function CreditNoteView({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const [{ creditNoteId }, query] = await Promise.all([params, searchParams]);
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const note = await getCreditNote(session, creditNoteId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!note) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title={t("note.notFound")} description={t("bill.notFoundHelp")}>
          <Link href="/billing/returns" className="text-sm font-semibold text-teal-strong hover:underline">
            {t("note.backToReturns")}
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
          {t("billing.returns")}
        </Link>
        <PrintButton />
      </div>
      {query.new === "1" ? (
        <p role="status" className="flex gap-2 rounded-xl bg-success-soft px-4 py-3 text-sm text-success print:hidden">
          <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("note.saved", { number: note.number })}
        </p>
      ) : null}

      <article className="flex flex-col gap-5 rounded-2xl border border-border bg-card p-5 sm:p-8 print:rounded-none print:border-0 print:p-0">
        <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:justify-between">
          <div>
            <p className="text-lg font-bold text-foreground">{note.shop.legalName ?? note.shop.name}</p>
            {note.shop.address ? (
              <p className="text-sm text-muted-foreground">
                {note.shop.address}
                {note.shop.pinCode ? ` – ${note.shop.pinCode}` : ""}
              </p>
            ) : null}
            <p className="text-sm text-muted-foreground">{note.shop.gstin ? t("common.gstinValue", { gstin: note.shop.gstin }) : t(note.shop.registration === "unregistered" ? "common.notRegistered" : "common.gstinNotSet")}</p>
          </div>
          <div className="sm:text-right">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("page.creditNote")}</p>
            <p className="text-lg font-bold text-foreground">{note.number}</p>
            <p className="text-sm text-muted-foreground">{billDate(note.businessDate, language)}</p>
            <p className="text-sm text-muted-foreground">
              <Link href={`/billing/invoices/${note.invoiceId}`} className="underline print:no-underline">{t("note.againstBefore", { number: note.invoiceNumber, date: note.invoiceDate ? billDate(note.invoiceDate, language) : "" })}</Link>
            </p>
          </div>
        </header>

        <section className="text-sm">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("common.customer.label")}</p>
          <p className="font-semibold text-foreground">{systemName(note.customer.name, language)}</p>
          {note.customer.gstin ? <p className="text-muted-foreground">{t("common.gstinValue", { gstin: note.customer.gstin })}</p> : null}
          <p className="mt-1 text-muted-foreground">{t("note.reasonLine", { reason: note.reason })}</p>
        </section>

        <div className="overflow-x-auto">
          <table className="stack-table w-full min-w-[32rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-2 font-medium">{t("common.item")}</th>
                <th className="py-2 pr-2 text-right font-medium">{t("common.qty")}</th>
                <th className="py-2 pr-2 text-right font-medium">GST</th>
                <th className="py-2 text-right font-medium">{t("common.taxable")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {note.lines.map((line) => (
                <tr key={line.id}>
                  <td data-title className="py-2 pr-2">
                    <p className="font-medium text-foreground">{line.productName}</p>
                    <p className="text-xs text-muted-foreground">{t(line.restock ? "note.backToStock" : "note.damaged")}</p>
                  </td>
                  <td data-label={t("common.qty")} className="py-2 pr-2 text-right whitespace-nowrap tabular-nums">
                    {line.baseQty} {line.baseUnit}
                  </td>
                  <td data-label="GST" className="py-2 pr-2 text-right text-muted-foreground">{formatBasisPoints(line.gstRateBp)}</td>
                  <td data-key data-label={t("common.taxable")} className="py-2 text-right">
                    <Money paise={line.taxablePaise} withPaise />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <dl className="flex flex-col gap-1 self-end text-sm sm:w-72">
          <Row label={t("common.taxableValue")} paise={note.taxablePaise} />
          {note.taxMode === "intra" ? (
            <>
              <Row label="CGST" paise={note.cgstPaise} />
              <Row label={stateTaxLabel(note.shop.stateCode)} paise={note.sgstPaise} />
            </>
          ) : null}
          {note.taxMode === "inter" ? <Row label="IGST" paise={note.igstPaise} /> : null}
          {note.taxMode === "none" ? <p className="text-xs text-muted-foreground">{t("note.noGst")}</p> : null}
          {note.roundOffPaise !== 0 ? <Row label={t("common.roundOff")} paise={note.roundOffPaise} /> : null}
          <div className="mt-1 flex items-baseline justify-between border-t border-border pt-2">
            <dt className="font-semibold text-foreground">{t("common.total")}</dt>
            <dd className="text-xl font-bold text-foreground">
              <Money paise={note.totalPaise} withPaise />
            </dd>
          </div>
          <p className="flex items-center justify-end gap-1 text-right text-xs text-muted-foreground">{amountInWords(note.totalPaise, language)}<HelpHint topic="amountInWords" /></p>
        </dl>

        <footer className="flex flex-col gap-1 border-t border-border pt-4 text-sm">
          <p className="text-foreground">{SETTLEMENT[note.settlement] ? t(SETTLEMENT[note.settlement]!) : note.settlement}</p>
          {note.balanceNowPaise !== null ? (
            <p className="text-xs text-muted-foreground print:hidden">
              {t("bill.outstandingNow", { name: systemName(note.customer.name, language) })}<Money paise={note.balanceNowPaise} withPaise />
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">{t("note.issuedBy", { name: systemName(note.createdByName, language) })}</p>
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
