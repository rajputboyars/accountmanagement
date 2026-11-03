import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, PackagePlus } from "lucide-react";
import { PaySupplierForm, ReversalButton, SupplierForm } from "@/components/purchases/supplier-forms";
import { Money } from "@/components/nexora/money";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { getSupplier } from "@/modules/purchasing";
import { requireSession } from "@/server/auth";
import { getLanguage, getT } from "@/server/i18n";
import type { MessageKey } from "@/shared/i18n";
import { billDate } from "@/shared/i18n/labels";
import { NotFoundError } from "@/server/errors";
import { formatPaise } from "@/shared/money";
import { HelpHint } from "@/components/nexora/help-hint";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.supplier") };
}

type Props = PageProps<"/suppliers/[supplierId]">;

export default function SupplierPage({ params }: Props) {
  return (
    <ProtectedPage permission="purchases.view" title="Supplier">
      <SupplierView params={params} />
    </ProtectedPage>
  );
}

const KIND: Record<string, MessageKey> = { opening: "suppliers.kind.opening", purchase: "suppliers.kind.purchase", payment: "suppliers.kind.payment", cancellation: "suppliers.kind.cancellation", correction: "suppliers.kind.correction", debit_note: "suppliers.kind.debitNote" };
const METHOD: Record<string, MessageKey> = { cash: "common.cash", upi: "common.upi", bank: "common.bank", cheque: "common.cheque", card: "common.card" };

async function SupplierView({ params }: Pick<Props, "params">) {
  const { supplierId } = await params;
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const dateText = (value: string) => billDate(value, language);
  const kindText = (kind: string) => (KIND[kind] ? t(KIND[kind]!) : kind);
  const supplier = await getSupplier(session, supplierId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!supplier) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title={t("suppliers.notFound")} description={t("customers.notFoundHelp")}>
          <Link href="/suppliers" className="text-sm font-semibold text-teal-strong hover:underline">
            {t("suppliers.back")}
          </Link>
        </SectionCard>
      </PageContainer>
    );
  }

  return (
    <PageContainer className="max-w-6xl">
      <Link href="/suppliers" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("page.suppliers")}
      </Link>
      <section className="flex flex-col gap-4 rounded-2xl bg-panel p-5 text-panel-foreground sm:flex-row sm:items-end sm:justify-between sm:p-6">
        <div className="min-w-0">
          <h2 className="text-xl font-bold sm:text-2xl">{supplier.name}</h2>
          <p className="text-sm text-panel-muted">
            {supplier.phone ?? t("suppliers.noPhone")} · {supplier.gstin ? t("common.gstinValue", { gstin: supplier.gstin }) : t("suppliers.noGstin")} · {t("suppliers.paysIn", { days: supplier.paymentTermsDays })}
          </p>
          {!supplier.isActive ? <Badge variant="neutral" className="mt-1">{t("common.switchedOff")}</Badge> : null}
        </div>
        <div className="flex flex-col gap-3 sm:items-end">
          <div className="sm:text-right">
            <p className="flex items-center gap-1 text-sm text-panel-muted sm:justify-end">{t(supplier.owedPaise >= 0 ? "suppliers.owe" : "suppliers.supplierOwes")}<HelpHint topic="supplierBalance" /></p>
            <p className="text-3xl font-bold">
              <Money paise={Math.abs(supplier.owedPaise)} withPaise />
            </p>
          </div>
          <Link href={`/purchases/receive?supplier=${supplier.id}`} className={buttonVariants({ size: "touch", variant: "outline", className: "border-panel-foreground/20 bg-panel-foreground/10 text-panel-foreground hover:bg-panel-foreground/20" })}>
            <PackagePlus aria-hidden="true" />
            {t("suppliers.receiveGoods")}
          </Link>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <SectionCard
            title={t("statement.title")}
            description={t("suppliers.statementHelp")}
            action={
              <Link href={`/suppliers/${supplier.id}/statement`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                {t("common.print")}
              </Link>
            }
            flush
          >
            {supplier.statement.length === 0 ? (
              <p className="px-5 pb-3 text-sm text-muted-foreground">{t("suppliers.noEntries")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="stack-table stack-table-flush w-full min-w-[32rem] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="px-5 py-2 font-medium">{t("statement.date")}</th>
                      <th className="px-3 py-2 font-medium">{t("statement.entry")}</th>
                      <th className="px-3 py-2 text-right font-medium">{t("suppliers.bought")}</th>
                      <th className="px-3 py-2 text-right font-medium">{t("suppliers.paid")}</th>
                      <th className="px-5 py-2 text-right font-medium">{t("suppliers.owe")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {supplier.statement.map((line) => (
                      <tr key={line.id}>
                        <td data-label={t("statement.date")} className="px-5 py-2 whitespace-nowrap text-muted-foreground">{dateText(line.entryDate)}</td>
                        <td data-title className="px-3 py-2">
                          {line.sourceType === "goods_receipt" ? (
                            <Link href={`/purchases/receipts/${line.sourceId}`} className="text-teal-strong hover:underline">
                              {kindText(line.kind)}
                            </Link>
                          ) : (
                            line.kind === "payment" && line.creditPaise ? t("suppliers.reversal") : kindText(line.kind)
                          )}
                        </td>
                        <td data-label={t("suppliers.bought")} className="px-3 py-2 text-right">{line.creditPaise ? <Money paise={line.creditPaise} withPaise /> : ""}</td>
                        <td data-label={t("suppliers.paid")} className="px-3 py-2 text-right">{line.debitPaise ? <Money paise={line.debitPaise} withPaise /> : ""}</td>
                        <td data-key data-label={t("suppliers.owe")} className="px-5 py-2 text-right font-medium">
                          <Money paise={line.owedAfterPaise} withPaise />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <SectionCard title={t("suppliers.payments")} flush>
            {supplier.payments.length === 0 ? (
              <p className="px-5 pb-3 text-sm text-muted-foreground">{t("suppliers.noPayments")}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {supplier.payments.map((payment) => (
                  <li key={payment.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-sm">
                    <span>
                      <span className="font-medium text-foreground">{t(payment.direction === "out" ? "suppliers.paid" : "suppliers.reversal")}</span> · {METHOD[payment.method] ? t(METHOD[payment.method]!) : payment.method} · {dateText(payment.businessDate)}
                      {payment.reference ? ` · ${payment.reference}` : ""}
                      {payment.status === "reversed" ? <Badge variant="neutral" className="ml-2">{t("status.reversed")}</Badge> : null}
                    </span>
                    <span className="flex items-center gap-2">
                      <Money paise={payment.amountPaise} withPaise />
                      {supplier.canPay && payment.direction === "out" && payment.status === "recorded" ? (
                        <ReversalButton confirmLabel={t("purchases.confirmPayment")} kind="payment" targetId={payment.id} label={t("common.reverse")} question={t("suppliers.reverseQuestion", { amount: formatPaise(payment.amountPaise, { withPaise: true }) })} refreshPath={`/suppliers/${supplier.id}`} />
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title={t("suppliers.goodsReceived")} flush>
            {supplier.receipts.length === 0 ? (
              <p className="px-5 pb-3 text-sm text-muted-foreground">{t("suppliers.nothingReceived")}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {supplier.receipts.map((receipt) => (
                  <li key={receipt.id}>
                    <Link href={`/purchases/receipts/${receipt.id}`} className="flex justify-between gap-3 px-5 py-2.5 text-sm hover:bg-muted/50">
                      <span>
                        <span className="font-medium text-foreground">{receipt.number}</span> · {dateText(receipt.receivedDate)}
                        {receipt.supplierBillNo ? ` · ${t("suppliers.billNumber", { number: receipt.supplierBillNo })}` : ""}
                        {receipt.status === "cancelled" ? <Badge variant="neutral" className="ml-2">{t("status.cancelled")}</Badge> : null}
                      </span>
                      <Money paise={receipt.totalPaise} withPaise />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          {supplier.canPay ? (
            <SectionCard title={t("suppliers.pay")}>
              {supplier.owedPaise > 0 ? <PaySupplierForm supplierId={supplier.id} owedText={formatPaise(supplier.owedPaise, { withPaise: true })} /> : <p className="text-sm text-muted-foreground">{t("suppliers.nothingOwed")}</p>}
            </SectionCard>
          ) : null}
          {supplier.canEdit ? (
            <SectionCard title={t("common.details")}>
              <SupplierForm supplier={supplier} />
            </SectionCard>
          ) : null}
        </div>
      </div>
    </PageContainer>
  );
}
