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
import { ORDER_STATUS } from "@/components/purchases/order-status";

export const metadata: Metadata = { title: "Purchase order" };

type Props = PageProps<"/purchases/orders/[orderId]">;

export default function OrderPage({ params, searchParams }: Props) {
  return (
    <ProtectedPage permission="purchases.view" title="Purchase order">
      <OrderView params={params} searchParams={searchParams} />
    </ProtectedPage>
  );
}

const dateText = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));

async function OrderView({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const [{ orderId }, query] = await Promise.all([params, searchParams]);
  const session = await requireSession();
  const order = await getPurchaseOrder(session, orderId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!order) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title="Order not found" description="It may belong to a different shop.">
          <Link href="/purchases" className="text-sm font-semibold text-teal-strong hover:underline">
            Back to purchases
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
        Purchases
      </Link>
      {query.new === "1" ? (
        <p role="status" className="flex gap-2 rounded-xl bg-success-soft px-4 py-3 text-sm text-success">
          <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          Order {order.number} saved. Receive it when the goods arrive.
        </p>
      ) : null}
      <section className="flex flex-col gap-3 rounded-2xl bg-panel p-5 text-panel-foreground sm:flex-row sm:items-end sm:justify-between sm:p-6">
        <div>
          <p className="text-xs font-semibold tracking-wide text-panel-muted uppercase">Purchase order</p>
          <h2 className="text-xl font-bold">{order.number}</h2>
          <p className="text-sm text-panel-muted">
            <Link href={`/suppliers/${order.supplier.id}`} className="underline">{order.supplier.name}</Link> · {dateText(order.orderDate)}
          </p>
          <Badge variant={status?.variant ?? "neutral"} className="mt-1">{status?.label ?? order.status}</Badge>
        </div>
        {order.canReceive ? (
          <Link href={`/purchases/receive?order=${order.id}`} className={buttonVariants({ size: "touch", variant: "outline", className: "border-panel-foreground/20 bg-panel-foreground/10 text-panel-foreground hover:bg-panel-foreground/20" })}>
            <PackagePlus aria-hidden="true" />
            Receive goods
          </Link>
        ) : null}
      </section>

      <SectionCard title="Items" flush>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-5 py-2 font-medium">Item</th>
                <th className="px-3 py-2 text-right font-medium">Ordered</th>
                <th className="px-3 py-2 text-right font-medium">Cost / unit</th>
                <th className="px-3 py-2 text-right font-medium">Received</th>
                <th className="px-5 py-2 text-right font-medium">Still expected</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {order.lines.map((line) => (
                <tr key={line.id}>
                  <td className="px-5 py-2.5 font-medium text-foreground">{line.productName}</td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums">
                    {line.qtyOrdered} {line.unit}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <Money paise={line.costPaisePerUnit} withPaise />
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {line.receivedBase} {line.baseUnit}
                  </td>
                  <td className="px-5 py-2.5 text-right tabular-nums">{order.status === "closed" || order.status === "cancelled" ? "—" : `${line.leftBase} ${line.baseUnit}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="Receipts" flush>
        {order.receipts.length === 0 ? (
          <p className="px-5 pb-3 text-sm text-muted-foreground">Nothing received yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {order.receipts.map((receipt) => (
              <li key={receipt.id}>
                <Link href={`/purchases/receipts/${receipt.id}`} className="flex justify-between gap-3 px-5 py-2.5 text-sm hover:bg-muted/50">
                  <span>
                    <span className="font-medium text-foreground">{receipt.number}</span> · {dateText(receipt.receivedDate)}
                    {receipt.status === "cancelled" ? <Badge variant="neutral" className="ml-2">Cancelled</Badge> : null}
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
          {order.canClose ? <ReversalButton kind="order-close" targetId={order.id} label="Close shortfall" question="Close this order? The items still expected won't be received; what came stays recorded." refreshPath={`/purchases/orders/${order.id}`} /> : null}
          {order.canCancel ? <ReversalButton kind="order-cancel" targetId={order.id} label="Cancel order" question="Cancel this order? Nothing was received on it, so stock and accounts don't change." refreshPath={`/purchases/orders/${order.id}`} /> : null}
        </div>
      ) : null}
    </PageContainer>
  );
}
