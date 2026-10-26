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
import { NotFoundError } from "@/server/errors";
import { formatPaise } from "@/shared/money";

export const metadata: Metadata = { title: "Supplier" };

type Props = PageProps<"/suppliers/[supplierId]">;

export default function SupplierPage({ params }: Props) {
  return (
    <ProtectedPage permission="purchases.view" title="Supplier">
      <SupplierView params={params} />
    </ProtectedPage>
  );
}

const dateText = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
const KIND: Record<string, string> = { opening: "Opening balance", purchase: "Goods received", payment: "Payment", cancellation: "Receipt cancelled", correction: "Correction", debit_note: "Debit note" };
const METHOD: Record<string, string> = { cash: "Cash", upi: "UPI", bank: "Bank", cheque: "Cheque", card: "Card" };

async function SupplierView({ params }: Pick<Props, "params">) {
  const { supplierId } = await params;
  const session = await requireSession();
  const supplier = await getSupplier(session, supplierId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!supplier) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title="Supplier not found" description="It may belong to a different shop.">
          <Link href="/suppliers" className="text-sm font-semibold text-teal-strong hover:underline">
            Back to suppliers
          </Link>
        </SectionCard>
      </PageContainer>
    );
  }

  return (
    <PageContainer className="max-w-6xl">
      <Link href="/suppliers" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Suppliers
      </Link>
      <section className="flex flex-col gap-4 rounded-2xl bg-panel p-5 text-panel-foreground sm:flex-row sm:items-end sm:justify-between sm:p-6">
        <div className="min-w-0">
          <h2 className="text-xl font-bold sm:text-2xl">{supplier.name}</h2>
          <p className="text-sm text-panel-muted">
            {supplier.phone ?? "No phone"} · {supplier.gstin ? `GSTIN ${supplier.gstin}` : "No GSTIN"} · pays in {supplier.paymentTermsDays} days
          </p>
          {!supplier.isActive ? <Badge variant="neutral" className="mt-1">Switched off</Badge> : null}
        </div>
        <div className="flex flex-col gap-3 sm:items-end">
          <div className="sm:text-right">
            <p className="text-sm text-panel-muted">{supplier.owedPaise >= 0 ? "You owe" : "Supplier owes you"}</p>
            <p className="text-3xl font-bold">
              <Money paise={Math.abs(supplier.owedPaise)} withPaise />
            </p>
          </div>
          <Link href={`/purchases/receive?supplier=${supplier.id}`} className={buttonVariants({ size: "touch", variant: "outline", className: "border-panel-foreground/20 bg-panel-foreground/10 text-panel-foreground hover:bg-panel-foreground/20" })}>
            <PackagePlus aria-hidden="true" />
            Receive goods
          </Link>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <SectionCard title="Statement" description="Every entry on this supplier's account, oldest first, with what you owed after each." flush>
            {supplier.statement.length === 0 ? (
              <p className="px-5 pb-3 text-sm text-muted-foreground">No entries yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[32rem] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="px-5 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 font-medium">Entry</th>
                      <th className="px-3 py-2 text-right font-medium">Bought</th>
                      <th className="px-3 py-2 text-right font-medium">Paid</th>
                      <th className="px-5 py-2 text-right font-medium">You owe</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {supplier.statement.map((line) => (
                      <tr key={line.id}>
                        <td className="px-5 py-2 whitespace-nowrap text-muted-foreground">{dateText(line.entryDate)}</td>
                        <td className="px-3 py-2">
                          {line.sourceType === "goods_receipt" ? (
                            <Link href={`/purchases/receipts/${line.sourceId}`} className="text-teal-strong hover:underline">
                              {KIND[line.kind] ?? line.kind}
                            </Link>
                          ) : (
                            (KIND[line.kind] ?? line.kind)
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">{line.creditPaise ? <Money paise={line.creditPaise} withPaise /> : ""}</td>
                        <td className="px-3 py-2 text-right">{line.debitPaise ? <Money paise={line.debitPaise} withPaise /> : ""}</td>
                        <td className="px-5 py-2 text-right font-medium">
                          <Money paise={line.owedAfterPaise} withPaise />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <SectionCard title="Payments" flush>
            {supplier.payments.length === 0 ? (
              <p className="px-5 pb-3 text-sm text-muted-foreground">No payments yet.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {supplier.payments.map((payment) => (
                  <li key={payment.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-sm">
                    <span>
                      <span className="font-medium text-foreground">{payment.direction === "out" ? "Paid" : "Reversal"}</span> · {METHOD[payment.method]} · {dateText(payment.businessDate)}
                      {payment.reference ? ` · ${payment.reference}` : ""}
                      {payment.status === "reversed" ? <Badge variant="neutral" className="ml-2">Reversed</Badge> : null}
                    </span>
                    <span className="flex items-center gap-2">
                      <Money paise={payment.amountPaise} withPaise />
                      {supplier.canPay && payment.direction === "out" && payment.status === "recorded" ? (
                        <ReversalButton kind="payment" targetId={payment.id} label="Reverse" question={`Reverse this ${formatPaise(payment.amountPaise, { withPaise: true })} payment? Use this only if it was entered by mistake; a matching entry is added.`} refreshPath={`/suppliers/${supplier.id}`} />
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title="Goods received" flush>
            {supplier.receipts.length === 0 ? (
              <p className="px-5 pb-3 text-sm text-muted-foreground">Nothing received yet.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {supplier.receipts.map((receipt) => (
                  <li key={receipt.id}>
                    <Link href={`/purchases/receipts/${receipt.id}`} className="flex justify-between gap-3 px-5 py-2.5 text-sm hover:bg-muted/50">
                      <span>
                        <span className="font-medium text-foreground">{receipt.number}</span> · {dateText(receipt.receivedDate)}
                        {receipt.supplierBillNo ? ` · bill ${receipt.supplierBillNo}` : ""}
                        {receipt.status === "cancelled" ? <Badge variant="neutral" className="ml-2">Cancelled</Badge> : null}
                      </span>
                      <Money paise={receipt.totalPaise} withPaise />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>

        <div className="flex flex-col gap-6">
          {supplier.canPay ? (
            <SectionCard title="Pay this supplier">
              {supplier.owedPaise > 0 ? <PaySupplierForm supplierId={supplier.id} owedText={formatPaise(supplier.owedPaise, { withPaise: true })} /> : <p className="text-sm text-muted-foreground">Nothing is owed right now.</p>}
            </SectionCard>
          ) : null}
          {supplier.canEdit ? (
            <SectionCard title="Details">
              <SupplierForm supplier={supplier} />
            </SectionCard>
          ) : null}
        </div>
      </div>
    </PageContainer>
  );
}
