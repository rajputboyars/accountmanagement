import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Money } from "@/components/nexora/money";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { CancelChallanButton, DeliverForm, OrderControls } from "@/components/sales/order-actions";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { getSalesOrder } from "@/modules/sales";
import { requireSession } from "@/server/auth";
import { NotFoundError } from "@/server/errors";
import { getLanguage, getT } from "@/server/i18n";
import { billDate } from "@/shared/i18n/labels";
import { unitShort } from "@/shared/i18n/unit-labels";
import { parseQuantity } from "@/shared/quantity";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("orders.title") };
}

type Props = { params: Promise<{ orderId: string }> };

export default function OrderPage({ params }: Props) {
  return (
    <ProtectedPage permission="billing.view" title="Order">
      <OrderView params={params} />
    </ProtectedPage>
  );
}

async function OrderView({ params }: Props) {
  const { orderId } = await params;
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const order = await getSalesOrder(session, orderId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!order) return null;
  const godowns = order.manyGodowns ? order.godowns.map((godown) => ({ id: godown.id, name: godown.isDefault && godown.name === "Main Store" ? t("godown.mainStore") : godown.name })) : undefined;
  const open = order.status === "confirmed" || order.status === "partially_delivered";
  // Pending quantities back in each line's own ordered unit (pending is held in base units; the unit's factor turns it back).
  const toUnit = (base: string, factor: string) => {
    const f = parseQuantity(factor);
    return f === BigInt(0) ? base : (Number(parseQuantity(base)) / Number(f)).toLocaleString("en-IN", { maximumFractionDigits: 3 });
  };
  const pendingLines = order.lines.filter((line) => Number(line.pendingBase) > 0).map((line) => ({ id: line.id, productName: line.productName, unit: unitShort(t, line.unit), pendingQty: toUnit(line.pendingBase, line.factor) }));
  const canBill = Number(order.unbilledDeliveredBase) > 0;
  return (
    <PageContainer className="max-w-5xl">
      <Link href="/billing/orders" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("orders.back")}
      </Link>
      <section className="flex flex-col gap-2 rounded-2xl bg-panel p-5 text-panel-foreground sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-bold">{order.number}</h2>
          <Badge variant={order.status === "cancelled" ? "danger" : order.status === "delivered" ? "success" : "warning"}>{t(`orders.status.${order.status}`)}</Badge>
        </div>
        <p className="text-sm text-panel-muted">
          {order.customer.name} · {billDate(order.orderDate, language)}
          {order.expectedDate ? ` · ${t("orders.expected")}: ${billDate(order.expectedDate, language)}` : ""}
          {order.godownName && order.manyGodowns ? ` · ${order.godownName === "Main Store" ? t("godown.mainStore") : order.godownName}` : ""}
        </p>
        {order.notes ? <p className="text-sm text-panel-muted">{order.notes}</p> : null}
      </section>

      <SectionCard title={t("orders.item")} description={t("orders.stockNote")} flush>
        <div className="overflow-x-auto">
          <table className="stack-table stack-table-flush w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-5 py-2 font-medium">{t("orders.item")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("orders.col.ordered")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("orders.col.reserved")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("orders.col.delivered")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("orders.col.billed")}</th>
                <th className="px-5 py-2 text-right font-medium">{t("orders.col.pending")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {order.lines.map((line) => (
                <tr key={line.id}>
                  <td data-title className="px-5 py-2.5">
                    <p className="font-medium text-foreground">{line.productName}</p>
                    <p className="text-xs text-muted-foreground">
                      {line.orderedQty} {unitShort(t, line.unit)} · <Money paise={line.indicativeRatePaise} withPaise />
                    </p>
                    {Number(line.shortBase) > 0 ? <p className="text-xs text-amber-ink">{t("orders.short", { qty: line.shortBase })}</p> : null}
                  </td>
                  <td data-label={t("orders.col.ordered")} className="px-3 py-2.5 text-right tabular-nums">{line.orderedBase}</td>
                  <td data-label={t("orders.col.reserved")} className="px-3 py-2.5 text-right tabular-nums">{line.reservedBase}</td>
                  <td data-label={t("orders.col.delivered")} className="px-3 py-2.5 text-right tabular-nums">{line.deliveredBase}</td>
                  <td data-label={t("orders.col.billed")} className="px-3 py-2.5 text-right tabular-nums">{line.billedBase}</td>
                  <td data-key data-label={t("orders.col.pending")} className="px-5 py-2.5 text-right font-semibold tabular-nums">{line.pendingBase}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <OrderControls orderId={order.id} status={order.status} godowns={godowns} canCreate={order.canCreate} />

      {open && order.canCreate && pendingLines.length > 0 ? (
        <SectionCard title={t("orders.deliver.title")}>
          <DeliverForm orderId={order.id} lines={pendingLines} godowns={godowns} />
        </SectionCard>
      ) : null}

      {order.challans.length > 0 ? (
        <SectionCard title={t("orders.deliveries")}>
          <ul className="flex flex-col divide-y divide-border">
            {order.challans.map((challan) => (
              <li key={challan.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/billing/challans/${challan.id}`} className="font-semibold text-teal-strong hover:underline">
                    {challan.number} · {billDate(challan.deliveryDate, language)}
                  </Link>
                  {challan.status === "cancelled" ? <Badge variant="danger">{t("orders.challan.cancelled")}</Badge> : null}
                </div>
                <p className="text-xs text-muted-foreground">{challan.lines.map((line) => `${line.productName}: ${line.qty} ${unitShort(t, line.unit)}`).join(" · ")}</p>
                {challan.status === "delivered" && order.canCancelChallan ? (
                  challan.billed ? (
                    <p className="text-xs text-muted-foreground">{t("orders.challan.billedNote")}</p>
                  ) : (
                    <CancelChallanButton challanId={challan.id} orderId={order.id} />
                  )
                ) : null}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {order.canCreate && canBill ? (
        <Link href={`/billing/orders/${order.id}/bill`} className={buttonVariants({ size: "touch", className: "self-start print:hidden" })}>
          {t("orders.bill.link")}
        </Link>
      ) : null}

      {order.bills.length > 0 ? (
        <SectionCard title={t("orders.bills")}>
          <ul className="flex flex-col divide-y divide-border text-sm">
            {order.bills.map((bill) => (
              <li key={bill.id} className="flex items-baseline justify-between gap-3 py-2">
                <Link href={`/billing/invoices/${bill.id}`} className="font-medium text-teal-strong hover:underline">
                  {bill.number}
                </Link>
                <span>
                  <Money paise={bill.totalPaise} withPaise />
                  {bill.status === "cancelled" ? ` · ${t("orders.challan.cancelled")}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </PageContainer>
  );
}
