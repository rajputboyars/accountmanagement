import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, CircleCheck } from "lucide-react";
import { ReversalButton } from "@/components/purchases/supplier-forms";
import { PrintButton } from "@/components/sales/invoice-actions";
import { Money } from "@/components/nexora/money";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { getGoodsReceipt } from "@/modules/purchasing";
import { requireSession } from "@/server/auth";
import { NotFoundError } from "@/server/errors";
import { getLanguage, getT } from "@/server/i18n";
import { billDate, cancelReasonLabel, systemName } from "@/shared/i18n/labels";
import { unitShort } from "@/shared/i18n/unit-labels";
import { formatBasisPoints } from "@/shared/pricing-engine";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.goodsReceipt") };
}

type Props = PageProps<"/purchases/receipts/[receiptId]">;

export default function ReceiptPage({ params, searchParams }: Props) {
  return (
    <ProtectedPage permission="purchases.view" title="Goods receipt">
      <ReceiptView params={params} searchParams={searchParams} />
    </ProtectedPage>
  );
}

async function ReceiptView({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const [{ receiptId }, query] = await Promise.all([params, searchParams]);
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const dateText = (value: string) => billDate(value, language);
  const receipt = await getGoodsReceipt(session, receiptId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!receipt) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title={t("purchases.receiptNotFound")} anchorId="not-found" description={t("purchases.otherShop")}>
          <Link href="/purchases" className="text-sm font-semibold text-teal-strong hover:underline">
            {t("purchases.back")}
          </Link>
        </SectionCard>
      </PageContainer>
    );
  }
  const cancelled = receipt.status === "cancelled";

  return (
    <PageContainer className="max-w-4xl print:max-w-none print:p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/purchases" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t("page.purchases")}
        </Link>
        <PrintButton />
      </div>
      {query.new === "1" ? (
        <p role="status" className="flex gap-2 rounded-xl bg-success-soft px-4 py-3 text-sm text-success print:hidden">
          <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("purchases.receiptSaved", { number: receipt.number })}
        </p>
      ) : null}
      {cancelled ? (
        <p role="status" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
          {t("purchases.cancelledBy", { name: systemName(receipt.cancelledByName ?? "", language), reason: cancelReasonLabel(receipt.cancelReason ?? "", language) })}
        </p>
      ) : null}

      <article className="flex flex-col gap-5 rounded-2xl border border-border bg-card p-5 sm:p-8 print:rounded-none print:border-0 print:p-0">
        <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:justify-between">
          <div>
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("purchases.receivedFrom")}</p>
            <p className="text-lg font-bold text-foreground">{receipt.supplier.name}</p>
            <p className="text-sm text-muted-foreground">
              {receipt.supplier.gstin ? t("common.gstinValue", { gstin: receipt.supplier.gstin }) : t("suppliers.noGstin")}
              {receipt.supplier.phone ? ` · ${receipt.supplier.phone}` : ""}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">{t("purchases.atShop", { name: receipt.shop.legalName ?? receipt.shop.name })}</p>
          </div>
          <div className="sm:text-right">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("page.goodsReceipt")}</p>
            <p className="text-lg font-bold text-foreground">{receipt.number}</p>
            <p className="text-sm text-muted-foreground">{t("purchases.receivedOn", { date: dateText(receipt.receivedDate) })}</p>
            {receipt.supplierBillNo ? (
              <p className="text-sm text-muted-foreground">
                {receipt.supplierBillDate ? t("purchases.supplierBillOf", { number: receipt.supplierBillNo, date: dateText(receipt.supplierBillDate) }) : t("purchases.supplierBill", { number: receipt.supplierBillNo })}
              </p>
            ) : null}
            {receipt.order ? (
              <p className="text-sm text-muted-foreground">
                {t("purchases.against")} <Link href={`/purchases/orders/${receipt.order.id}`} className="underline print:no-underline">{receipt.order.number}</Link>
              </p>
            ) : null}
            {cancelled ? <Badge variant="danger" className="mt-1">{t("purchases.status.cancelled")}</Badge> : null}
          </div>
        </header>

        <div className="overflow-x-auto">
          <table className="stack-table w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-2 font-medium">{t("common.item")}</th>
                <th className="py-2 pr-2 text-right font-medium">{t("common.qty")}</th>
                <th className="py-2 pr-2 text-right font-medium">{t("purchases.purchasePriceUnit")}</th>
                <th className="py-2 pr-2 text-right font-medium">GST</th>
                <th className="py-2 text-right font-medium">{t("common.value")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {receipt.lines.map((line) => (
                <tr key={line.id}>
                  <td data-title className="py-2 pr-2">
                    <p className="font-medium text-foreground">{line.productName}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("purchases.costPer", { unit: unitShort(t, line.baseUnit) })} <Money paise={line.unitCostPaise} withPaise />
                    </p>
                  </td>
                  <td data-label={t("common.qty")} className="py-2 pr-2 text-right whitespace-nowrap tabular-nums">
                    <span>
                      {line.qty} {unitShort(t, line.unit)}
                      {line.unit !== line.baseUnit ? <span className="block text-xs text-muted-foreground">({line.qtyBase} {unitShort(t, line.baseUnit)})</span> : null}
                    </span>
                  </td>
                  <td data-label={t("purchases.purchasePriceUnit")} className="py-2 pr-2 text-right">
                    <Money paise={line.costPaisePerUnit} withPaise />
                  </td>
                  <td data-label="GST" className="py-2 pr-2 text-right text-muted-foreground">
                    <span>
                      {formatBasisPoints(line.gstRateBp)}
                      {line.gstPaise ? (
                        <span className="block text-xs">
                          <Money paise={line.gstPaise} withPaise />
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td data-key data-label={t("common.value")} className="py-2 text-right">
                    <Money paise={line.linePaise} withPaise />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <dl className="flex flex-col gap-1 self-end text-sm sm:w-72">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{t("common.value")}</dt>
            <dd>
              <Money paise={receipt.taxablePaise} withPaise />
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{t("purchases.gstInput")}</dt>
            <dd>
              <Money paise={receipt.gstPaise} withPaise />
            </dd>
          </div>
          <div className="mt-1 flex items-baseline justify-between border-t border-border pt-2">
            <dt className="font-semibold text-foreground">{t("common.total")}</dt>
            <dd className="text-xl font-bold text-foreground">
              <Money paise={receipt.totalPaise} withPaise />
            </dd>
          </div>
        </dl>
        <footer className="text-xs text-muted-foreground">{t("purchases.receivedBy", { name: systemName(receipt.createdByName, language) })}</footer>
      </article>

      {receipt.canCancel ? (
        <div className="print:hidden">
          <ReversalButton kind="receipt" targetId={receipt.id} label={t("purchases.cancelReceipt")} confirmLabel={t("purchases.cancelReceiptYes")} question={t("purchases.cancelReceiptQuestion")} refreshPath={`/purchases/receipts/${receipt.id}`} />
        </div>
      ) : null}
    </PageContainer>
  );
}
