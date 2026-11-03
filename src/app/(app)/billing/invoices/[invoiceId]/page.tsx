import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, CircleCheck, Plus, Undo2 } from "lucide-react";
import { CancelInvoice, PrintButton } from "@/components/sales/invoice-actions";
import { Money } from "@/components/nexora/money";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { COMPOSITION_DECLARATION, documentTitle, isGstState, stateTaxLabel } from "@/shared/gst";
import { stateName } from "@/shared/i18n/unit-labels";
import { buttonVariants } from "@/components/ui/button";
import { ShareBill } from "@/components/sales/share-bill";
import { hasPermission } from "@/modules/identity";
import { getInvoice } from "@/modules/sales";
import { requireSession } from "@/server/auth";
import { getLanguage, getT } from "@/server/i18n";
import { billDate, cancelReasonLabel, rateReasonLabel, systemName } from "@/shared/i18n/labels";
import { translateServerMessage, type MessageKey } from "@/shared/i18n";
import { NotFoundError } from "@/server/errors";
import { amountInWords } from "@/shared/i18n/amount-words";
import { formatBasisPoints } from "@/shared/pricing-engine";
import { HelpHint } from "@/components/nexora/help-hint";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.bill") };
}

type Props = PageProps<"/billing/invoices/[invoiceId]">;

export default function InvoicePage({ params, searchParams }: Props) {
  return (
    <ProtectedPage permission="billing.view" title="Bill">
      <InvoiceView params={params} searchParams={searchParams} />
    </ProtectedPage>
  );
}

const METHOD_LABEL: Record<string, MessageKey> = { cash: "common.cash", upi: "common.upi", card: "common.card", bank: "common.bank", cheque: "common.cheque" };

async function InvoiceView({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const [{ invoiceId }, query] = await Promise.all([params, searchParams]);
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const methodText = (method: string) => (METHOD_LABEL[method] ? t(METHOD_LABEL[method]!) : method);
  const invoice = await getInvoice(session, invoiceId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!invoice) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title={t("bill.notFound")} description={t("bill.notFoundHelp")}>
          <Link href="/billing/invoices" className="text-sm font-semibold text-teal-strong hover:underline">
            {t("bill.backToBills")}
          </Link>
        </SectionCard>
      </PageContainer>
    );
  }

  const canEditCustomer = await hasPermission(session, "customers.edit");
  const cancelled = invoice.status === "cancelled";
  const received = invoice.payments.filter((payment) => payment.direction === "in");
  const refunded = invoice.payments.filter((payment) => payment.direction === "out");
  const creditPaise = invoice.totalPaise - invoice.paidNowPaise;
  const rateGroups = [...new Set(invoice.lines.map((line) => line.gstRateBp))].sort((a, b) => a - b).map((rate) => {
    const lines = invoice.lines.filter((line) => line.gstRateBp === rate);
    return { rate, taxable: lines.reduce((sum, line) => sum + line.taxablePaise, 0), cgst: lines.reduce((sum, line) => sum + line.cgstPaise, 0), sgst: lines.reduce((sum, line) => sum + line.sgstPaise, 0), igst: lines.reduce((sum, line) => sum + line.igstPaise, 0) };
  });
  const mode = invoice.taxMode;
  const stateTax = stateTaxLabel(invoice.shop.stateCode);
  const place = invoice.placeOfSupply ?? invoice.shop.stateCode;

  return (
    <PageContainer className="max-w-4xl print:max-w-none print:p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/billing/invoices" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t("billing.bills")}
        </Link>
        <div className="flex flex-wrap gap-2">
          {invoice.status === "issued" ? (
            <ShareBill
              invoiceId={invoice.id}
              phone={invoice.customer.type === "walkin" ? null : invoice.customer.phone}
              customer={invoice.customer.type === "walkin" ? null : { id: invoice.customer.id, name: invoice.customer.name, language: invoice.customer.communicationLanguage }}
              canSaveLanguage={canEditCustomer}
            />
          ) : null}
          <PrintButton />
          <Link href="/billing" className={buttonVariants({ size: "touch" })}>
            <Plus aria-hidden="true" />
            {t("billing.newBill")}
          </Link>
        </div>
      </div>

      {query.new === "1" ? (
        <p role="status" className="flex gap-2 rounded-xl bg-success-soft px-4 py-3 text-sm text-success print:hidden">
          <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("bill.saved", { number: invoice.number })}
        </p>
      ) : null}
      {cancelled ? (
        <p role="status" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
          {t("bill.cancelledBy", { name: systemName(invoice.cancelledByName ?? "", language), reason: cancelReasonLabel(invoice.cancelReason ?? "", language) })}
        </p>
      ) : null}

      <article className="flex flex-col gap-5 rounded-2xl border border-border bg-card p-5 sm:p-8 print:rounded-none print:border-0 print:p-0">
        <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:justify-between">
          <div>
            <p className="text-lg font-bold text-foreground">{invoice.shop.legalName ?? invoice.shop.name}</p>
            {invoice.shop.address ? (
              <p className="text-sm text-muted-foreground">
                {invoice.shop.address}
                {invoice.shop.pinCode ? ` – ${invoice.shop.pinCode}` : ""}
              </p>
            ) : null}
            {invoice.shop.email ? <p className="text-sm text-muted-foreground">{invoice.shop.email}</p> : null}
            <p className="text-sm text-muted-foreground">
              {invoice.shop.gstin ? t("common.gstinValue", { gstin: invoice.shop.gstin }) : t(invoice.shop.registration === "unregistered" ? "common.notRegistered" : "common.gstinNotSet")} · {t("bill.stateLine", { code: invoice.shop.stateCode, state: isGstState(invoice.shop.stateCode) ? stateName(t, invoice.shop.stateCode) : "" })}
              {invoice.shop.phone ? ` · ${invoice.shop.phone}` : ""}
            </p>
          </div>
          <div className="sm:text-right">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{translateServerMessage(documentTitle(mode), language)}</p>
            <p className="text-lg font-bold text-foreground">{invoice.number}</p>
            <p className="text-sm text-muted-foreground">{billDate(invoice.businessDate, language)}</p>
            <div className="mt-1 flex gap-1.5 sm:justify-end">
              <Badge variant={invoice.priceList === "wholesale" ? "info" : "neutral"}>{t(invoice.priceList === "wholesale" ? "common.wholesale" : "common.retail")}</Badge>
              {cancelled ? <Badge variant="danger">{t("status.cancelled")}</Badge> : null}
            </div>
          </div>
        </header>

        <section aria-label={t("bill.billedTo")} className="text-sm">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("bill.billedTo")}</p>
          <p className="font-semibold text-foreground">{systemName(invoice.customer.name, language)}</p>
          {invoice.customer.phone ? <p className="text-muted-foreground">{invoice.customer.phone}</p> : null}
          {invoice.customer.gstin ? <p className="text-muted-foreground">{t("common.gstinValue", { gstin: invoice.customer.gstin })}</p> : null}
          {mode !== "none" ? (
            <p className="text-muted-foreground">
              {t("bill.placeLine", { code: place, state: isGstState(place) ? stateName(t, place) : "" })}
            </p>
          ) : null}
        </section>

        <div className="overflow-x-auto">
          <table className="stack-table w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-2 font-medium">#</th>
                <th className="py-2 pr-2 font-medium">{t("common.item")}</th>
                <th className="py-2 pr-2 text-right font-medium">{t("common.qty")}</th>
                <th className="py-2 pr-2 text-right font-medium">{t("common.rate")}</th>
                {mode !== "none" ? <th className="py-2 pr-2 text-right font-medium">GST</th> : null}
                <th className="py-2 text-right font-medium">{t("common.amount")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {invoice.lines.map((line) => (
                <tr key={line.id}>
                  <td data-lead className="py-2 pr-2 align-top text-muted-foreground">{line.lineNo}</td>
                  <td data-title className="py-2 pr-2 align-top">
                    <p className="font-medium text-foreground">{line.productName}</p>
                    <p className="text-xs text-muted-foreground">
                      {line.hsn ? `${t("bill.hsn", { hsn: line.hsn })} · ` : ""}
                      {rateReasonLabel(line.rateReason, language)}
                    </p>
                  </td>
                  <td data-label={t("common.qty")} className="py-2 pr-2 text-right align-top whitespace-nowrap tabular-nums">
                    <span>
                      {line.qty} {line.unit}
                      {line.unit !== line.baseUnit ? <span className="block text-xs text-muted-foreground">({line.baseQty} {line.baseUnit})</span> : null}
                    </span>
                  </td>
                  <td data-label={t("common.rate")} className="py-2 pr-2 text-right align-top">
                    <Money paise={line.ratePaise} withPaise />
                  </td>
                  {mode !== "none" ? <td data-label="GST" className="py-2 pr-2 text-right align-top text-muted-foreground">{formatBasisPoints(line.gstRateBp)}</td> : null}
                  <td data-key data-label={t("common.amount")} className="py-2 text-right align-top">
                    <Money paise={line.linePaise} withPaise />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          {mode === "none" ? (
            <p className="text-sm text-muted-foreground">{invoice.shop.registration === "composition" ? COMPOSITION_DECLARATION : t("bill.noGstUnregistered")}</p>
          ) : (
            <div className="text-sm">
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("bill.taxSummary")}</p>
              <table className="stack-table mt-1 w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 font-medium">GST</th>
                    <th className="py-1 text-right font-medium">{t("common.taxable")}</th>
                    {mode === "inter" ? (
                      <th className="py-1 text-right font-medium">IGST</th>
                    ) : (
                      <>
                        <th className="py-1 text-right font-medium">CGST</th>
                        <th className="py-1 text-right font-medium">{stateTax}</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rateGroups.map((group) => (
                    <tr key={group.rate}>
                      <td data-title className="py-1">{formatBasisPoints(group.rate)}</td>
                      <td data-key data-label={t("common.taxable")} className="py-1 text-right">
                        <Money paise={group.taxable} withPaise />
                      </td>
                      {mode === "inter" ? (
                        <td data-label="IGST" className="py-1 text-right">
                          <Money paise={group.igst} withPaise />
                        </td>
                      ) : (
                        <>
                          <td data-label="CGST" className="py-1 text-right">
                            <Money paise={group.cgst} withPaise />
                          </td>
                          <td data-label={stateTax} className="py-1 text-right">
                            <Money paise={group.sgst} withPaise />
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <dl className="flex flex-col gap-1 text-sm">
            <Row label={t("common.subtotal")} paise={invoice.subtotalPaise} />
            {invoice.discountPaise > 0 ? <Row label={t("bill.discountPercent", { percent: formatBasisPoints(invoice.discountBp) })} paise={-invoice.discountPaise} /> : null}
            <Row label={t("common.taxableValue")} paise={invoice.taxablePaise} />
            {mode === "intra" ? (
              <>
                <Row label="CGST" paise={invoice.cgstPaise} />
                <Row label={stateTax} paise={invoice.sgstPaise} />
              </>
            ) : null}
            {mode === "inter" ? <Row label="IGST" paise={invoice.igstPaise} /> : null}
            {invoice.roundOffPaise !== 0 ? <Row label={t("common.roundOff")} paise={invoice.roundOffPaise} /> : null}
            <div className="mt-1 flex items-baseline justify-between border-t border-border pt-2">
              <dt className="font-semibold text-foreground">{t("common.total")}</dt>
              <dd className="text-xl font-bold text-foreground">
                <Money paise={invoice.totalPaise} withPaise />
              </dd>
            </div>
            <p className="flex items-center justify-end gap-1 text-right text-xs text-muted-foreground">{amountInWords(invoice.totalPaise, language)}<HelpHint topic="amountInWords" /></p>
          </dl>
        </div>

        {invoice.shop.upiId || invoice.shop.bankDetails || invoice.shop.terms ? (
          <section aria-label={t("bill.termsLabel")} className="flex flex-col gap-1 border-t border-border pt-4 text-xs text-muted-foreground">
            {invoice.shop.upiId ? <p>UPI: {invoice.shop.upiId}</p> : null}
            {invoice.shop.bankDetails ? <p>{t("bill.bankLine", { details: invoice.shop.bankDetails })}</p> : null}
            {invoice.shop.terms ? <p className="whitespace-pre-line">{invoice.shop.terms}</p> : null}
          </section>
        ) : null}

        <section aria-label={t("bill.payment")} className="flex flex-col gap-1 border-t border-border pt-4 text-sm">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("bill.payment")}</p>
          {received.length === 0 ? <p className="text-foreground">{t("bill.fullCredit")}</p> : null}
          {received.map((payment) => (
            <Row key={payment.id} label={payment.status === "reversed" ? t("bill.refundedMark", { method: methodText(payment.method) }) : methodText(payment.method)} paise={payment.amountPaise} />
          ))}
          {creditPaise > 0 && !cancelled ? <Row label={t("bill.addedOutstanding")} paise={creditPaise} /> : null}
          {refunded.map((payment) => (
            <Row key={payment.id} label={t("bill.refundLine", { method: methodText(payment.method) })} paise={-payment.amountPaise} />
          ))}
          {invoice.balanceNowPaise !== null ? (
            <p className="mt-1 text-xs text-muted-foreground print:hidden">
              {t("bill.outstandingNow", { name: systemName(invoice.customer.name, language) })}<Money paise={invoice.balanceNowPaise} withPaise />
            </p>
          ) : null}
        </section>

        <footer className="text-xs text-muted-foreground">
          {t("bill.footer", { name: systemName(invoice.createdByName, language) })}
        </footer>
      </article>

      {invoice.creditNotes.length > 0 ? (
        <SectionCard title={t("bill.returnsOnBill")} className="print:hidden">
          <ul className="flex flex-col divide-y divide-border text-sm">
            {invoice.creditNotes.map((note) => (
              <li key={note.id} className="flex justify-between gap-3 py-2 first:pt-0">
                <Link href={`/billing/returns/${note.id}`} className="font-semibold text-teal-strong hover:underline">
                  {note.number}
                </Link>
                <span className="text-muted-foreground">
                  {billDate(note.businessDate, language)} · <Money paise={note.totalPaise} withPaise />
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
              {t("bill.returnItems")}
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
