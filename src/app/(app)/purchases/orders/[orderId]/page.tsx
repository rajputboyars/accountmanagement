import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, CircleCheck, PackagePlus } from "lucide-react";
import { ReversalButton } from "@/components/purchases/supplier-forms";
import { Money } from "@/components/nexora/money";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { getPurchaseOrder } from "@/modules/purchasing";
import { requireSession } from "@/server/auth";
import { NotFoundError } from "@/server/errors";
import { getLanguage, getT } from "@/server/i18n";
import { billDate } from "@/shared/i18n/labels";
import { unitShort } from "@/shared/i18n/unit-labels";
import { ORDER_STATUS } from "@/components/purchases/order-status";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.purchaseOrder") };
}

type Props = PageProps<"/purchases/orders/[orderId]">;

export default function OrderPage({ params, searchParams }: Props) {
  return (
    <ProtectedPage permission="purchases.view" title="Purchase order">
      <OrderView params={params} searchParams={searchParams} />
    </ProtectedPage>
  );
}

async function OrderView({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const [{ orderId }, query] = await Promise.all([params, searchParams]);
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const dateText = (value: string) => billDate(value, language);
  const order = await getPurchaseOrder(session, orderId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!order) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title={t("purchases.orderNotFound")} anchorId="not-found" description={t("purchases.otherShop")}>
          <Link href="/purchases" className="text-sm font-semibold text-teal-strong hover:underline">
            {t("purchases.back")}
          </Link>
        </SectionCard>
      </PageContainer>
    );
  }
  const status = ORDER_STATUS[order.status];

  return (
    <PageContainer className="max-w-5xl">
      <Link href="/purchases" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("page.purchases")}
      </Link>
      {query.new === "1" ? (
        <p role="status" className="flex gap-2 rounded-xl bg-success-soft px-4 py-3 text-sm text-success">
          <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("purchases.orderSaved", { number: order.number })}
        </p>
      ) : null}
      <section className="flex flex-col gap-3 rounded-2xl bg-panel p-5 text-panel-foreground sm:flex-row sm:items-end sm:justify-between sm:p-6">
        <div>
          <p className="text-xs font-semibold tracking-wide text-panel-muted uppercase">{t("page.purchaseOrder")}</p>
          <h2 className="text-xl font-bold">{order.number}</h2>
          <p className="text-sm text-panel-muted">
            <Link href={`/suppliers/${order.supplier.id}`} className="underline">{order.supplier.name}</Link> · {dateText(order.orderDate)}
          </p>
          <Badge variant={status?.variant ?? "neutral"} className="mt-1">{status ? t(status.label) : order.status}</Badge>
        </div>
        {order.canReceive ? (
          <Link href={`/purchases/receive?order=${order.id}`} className={buttonVariants({ size: "touch", variant: "outline", className: "border-panel-foreground/20 bg-panel-foreground/10 text-panel-foreground hover:bg-panel-foreground/20" })}>
            <PackagePlus aria-hidden="true" />
            {t("suppliers.receiveGoods")}
          </Link>
        ) : null}
      </section>

      <SectionCard title={t("purchases.items")} anchorId="items" flush>
        <div className="overflow-x-auto">
          <table className="stack-table stack-table-flush w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-5 py-2 font-medium">{t("common.item")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("purchases.ordered")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("purchases.purchasePriceUnit")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("purchases.received")}</th>
                <th className="px-5 py-2 text-right font-medium">{t("purchases.stillExpected")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {order.lines.map((line) => (
                <tr key={line.id}>
                  <td data-title className="px-5 py-2.5 font-medium text-foreground">{line.productName}</td>
                  <td data-label={t("purchases.ordered")} className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums">
                    {line.qtyOrdered} {unitShort(t, line.unit)}
                  </td>
                  <td data-key data-label={t("purchases.purchasePriceUnit")} className="px-3 py-2.5 text-right">
                    <Money paise={line.costPaisePerUnit} withPaise />
                  </td>
                  <td data-label={t("purchases.received")} className="px-3 py-2.5 text-right tabular-nums">
                    {line.receivedBase} {unitShort(t, line.baseUnit)}
                  </td>
                  <td data-label={t("purchases.stillExpected")} className="px-5 py-2.5 text-right tabular-nums">{order.status === "closed" || order.status === "cancelled" ? "—" : `${line.leftBase} ${unitShort(t, line.baseUnit)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title={t("purchases.receipts")} anchorId="receipts" flush>
        {order.receipts.length === 0 ? (
          <p className="px-5 pb-3 text-sm text-muted-foreground">{t("suppliers.nothingReceived")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {order.receipts.map((receipt) => (
              <li key={receipt.id}>
                <Link href={`/purchases/receipts/${receipt.id}`} className="flex justify-between gap-3 px-5 py-2.5 text-sm hover:bg-muted/50">
                  <span>
                    <span className="font-medium text-foreground">{receipt.number}</span> · {dateText(receipt.receivedDate)}
                    {receipt.status === "cancelled" ? <Badge variant="neutral" className="ml-2">{t("purchases.status.cancelled")}</Badge> : null}
                  </span>
                  <Money paise={receipt.totalPaise} withPaise />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {order.canCancel || order.canClose ? (
        <div className="flex flex-wrap gap-2">
          {order.canClose ? <ReversalButton kind="order-close" targetId={order.id} label={t("purchases.closeShort")} confirmLabel={t("purchases.closeShortYes")} question={t("purchases.closeQuestion")} refreshPath={`/purchases/orders/${order.id}`} /> : null}
          {order.canCancel ? <ReversalButton kind="order-cancel" targetId={order.id} label={t("purchases.cancelOrder")} confirmLabel={t("purchases.cancelOrderYes")} question={t("purchases.cancelOrderQuestion")} refreshPath={`/purchases/orders/${order.id}`} /> : null}
        </div>
      ) : null}
    </PageContainer>
  );
}
