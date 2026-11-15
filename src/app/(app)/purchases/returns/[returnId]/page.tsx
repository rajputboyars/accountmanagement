import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, CircleCheck } from "lucide-react";
import { Money } from "@/components/nexora/money";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { PrintButton } from "@/components/sales/invoice-actions";
import { getPurchaseReturn } from "@/modules/purchasing";
import { requireSession } from "@/server/auth";
import { NotFoundError } from "@/server/errors";
import { getLanguage, getT } from "@/server/i18n";
import { billDate, systemName } from "@/shared/i18n/labels";
import { unitShort } from "@/shared/i18n/unit-labels";
import { formatBasisPoints } from "@/shared/pricing-engine";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("purchases.debit.title") };
}

type Props = { params: Promise<{ returnId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default function DebitNotePage({ params, searchParams }: Props) {
  return (
    <ProtectedPage permission="purchases.view" title="Debit note">
      <DebitNote params={params} searchParams={searchParams} />
    </ProtectedPage>
  );
}

/** The supplier's debit note: what went back, at the receipt's own unit, price and GST, and how the supplier settles it. Printable. */
async function DebitNote({ params, searchParams }: Props) {
  const [{ returnId }, query] = await Promise.all([params, searchParams]);
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const note = await getPurchaseReturn(session, returnId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!note) return null;
  const dateText = (value: string) => billDate(value, language);
  return (
    <PageContainer className="max-w-4xl">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/purchases/receipts/${note.receipt.id}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden="true" />
          {note.receipt.number}
        </Link>
        <PrintButton />
      </div>
      {query.new === "1" ? (
        <p role="status" className="flex gap-2 rounded-xl bg-success-soft px-4 py-3 text-sm text-success print:hidden">
          <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("purchases.return.done", { number: note.number })}
        </p>
      ) : null}
      <article className="flex flex-col gap-5 rounded-2xl border border-border bg-card p-5 sm:p-8 print:rounded-none print:border-0 print:p-0">
        <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:justify-between">
          <div>
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("purchases.debit.title")}</p>
            <p className="text-lg font-bold text-foreground">{note.supplier.name}</p>
            <p className="text-sm text-muted-foreground">
              {note.supplier.gstin ? t("common.gstinValue", { gstin: note.supplier.gstin }) : t("suppliers.noGstin")}
              {note.supplier.phone ? ` · ${note.supplier.phone}` : ""}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">{t("purchases.atShop", { name: note.shop.legalName ?? note.shop.name })}</p>
          </div>
          <div className="sm:text-right">
            <p className="text-lg font-bold text-foreground">{note.number}</p>
            <p className="text-sm text-muted-foreground">{dateText(note.returnDate)}</p>
            <p className="text-sm text-muted-foreground">{t("purchases.debit.against", { number: note.receipt.number })}</p>
            {note.receipt.supplierBillNo ? <p className="text-sm text-muted-foreground">{t("purchases.supplierBill", { number: note.receipt.supplierBillNo })}</p> : null}
            <p className="text-sm text-muted-foreground">{t("purchases.debit.from", { godown: note.godownName === "Main Store" ? t("godown.mainStore") : note.godownName })}</p>
          </div>
        </header>
        <div className="overflow-x-auto">
          <table className="stack-table w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-2 font-medium">{t("common.item")}</th>
                <th className="py-2 pr-2 text-right font-medium">{t("common.qty")}</th>
                <th className="py-2 pr-2 text-right font-medium">GST</th>
                <th className="py-2 text-right font-medium">{t("common.value")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {note.lines.map((line) => (
                <tr key={line.id}>
                  <td data-title className="py-2 pr-2 font-medium text-foreground">{line.productName}</td>
                  <td data-label={t("common.qty")} className="py-2 pr-2 text-right whitespace-nowrap tabular-nums">
                    {line.qty} {unitShort(t, line.unit)}
                  </td>
                  <td data-label="GST" className="py-2 pr-2 text-right text-muted-foreground">
                    {formatBasisPoints(line.gstRateBp)} · <Money paise={line.gstPaise} withPaise />
                  </td>
                  <td data-key data-label={t("common.value")} className="py-2 text-right">
                    <Money paise={line.taxablePaise} withPaise />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="flex flex-col gap-1 self-end text-sm sm:w-72">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{t("common.value")}</dt>
            <dd><Money paise={note.taxablePaise} withPaise /></dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{t("purchases.gstInput")}</dt>
            <dd><Money paise={note.gstPaise} withPaise /></dd>
          </div>
          <div className="mt-1 flex items-baseline justify-between border-t border-border pt-2">
            <dt className="font-semibold text-foreground">{t("common.total")}</dt>
            <dd className="text-xl font-bold text-foreground"><Money paise={note.totalPaise} withPaise /></dd>
          </div>
        </dl>
        <footer className="flex flex-col gap-1 text-xs text-muted-foreground">
          <p>{t("purchases.debit.reasonLine", { reason: note.reason })}</p>
          <p>{note.settlement === "refund" ? `${t("purchases.debit.refund")} (${note.refundMethod})` : t("purchases.debit.credit")}</p>
          <p>{t("purchases.receivedBy", { name: systemName(note.createdByName, language) })}</p>
        </footer>
      </article>
    </PageContainer>
  );
}
