import type { Metadata } from "next";
import Link from "next/link";
import { ClipboardList, PackagePlus } from "lucide-react";
import { ORDER_STATUS } from "@/components/purchases/order-status";
import { Money } from "@/components/nexora/money";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { getNavItem } from "@/config/navigation";
import { hasPermission } from "@/modules/identity";
import { listGoodsReceipts, listPurchaseOrders, PURCHASES_EDIT, STOCK_RECEIVE } from "@/modules/purchasing";
import { requireSession } from "@/server/auth";

const item = getNavItem("purchases");

export const metadata: Metadata = { title: "Purchases" };

export default function PurchasesPage() {
  return (
    <ProtectedPage permission="purchases.view" title={item.label}>
      <Purchases />
    </ProtectedPage>
  );
}

const dateText = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));

async function Purchases() {
  const session = await requireSession();
  const [orders, receipts, canOrder, canReceive] = await Promise.all([listPurchaseOrders(session), listGoodsReceipts(session), hasPermission(session, PURCHASES_EDIT), hasPermission(session, STOCK_RECEIVE)]);
  const open = orders.filter((order) => order.status === "ordered" || order.status === "partially_received");

  return (
    <PageContainer>
      <PageIntro
        description="Order from suppliers and receive goods. Receiving adds stock, updates the cost price and adds the bill to what you owe."
        actions={
          <>
            {canOrder ? (
              <Link href="/purchases/new" className={buttonVariants({ variant: "outline", size: "touch" })}>
                <ClipboardList aria-hidden="true" />
                New order
              </Link>
            ) : null}
            {canReceive ? (
              <Link href="/purchases/receive" className={buttonVariants({ size: "touch" })}>
                <PackagePlus aria-hidden="true" />
                Receive goods
              </Link>
            ) : null}
          </>
        }
      />
      <section className="grid grid-cols-2 gap-3 rounded-2xl bg-panel p-5 text-panel-foreground sm:grid-cols-3 sm:p-6">
        <div>
          <p className="text-2xl font-bold tabular-nums">{open.length}</p>
          <p className="text-xs text-panel-muted">Orders waiting for goods</p>
        </div>
        <div>
          <p className="text-2xl font-bold tabular-nums">{orders.filter((order) => order.status === "partially_received").length}</p>
          <p className="text-xs text-panel-muted">Received short</p>
        </div>
        <div>
          <p className="text-2xl font-bold tabular-nums">{receipts.filter((receipt) => receipt.status === "received").length}</p>
          <p className="text-xs text-panel-muted">Goods receipts</p>
        </div>
      </section>
      <div className="grid gap-6 xl:grid-cols-2">
        <SectionCard title="Purchase orders" description="Newest first" flush>
          {orders.length === 0 ? (
            <p className="border-t border-border px-5 py-10 text-center text-sm text-muted-foreground">No orders yet. Ordering first is optional: you can receive goods directly.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border border-t border-border">
              {orders.map((order) => (
                <li key={order.id}>
                  <Link href={`/purchases/orders/${order.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-muted/50">
                    <span className="min-w-0">
                      <span className="block font-semibold text-foreground">{order.number}</span>
                      <span className="block text-xs text-muted-foreground">
                        {dateText(order.orderDate)} · {order.supplierName}
                      </span>
                    </span>
                    <Badge variant={ORDER_STATUS[order.status]?.variant ?? "neutral"}>{ORDER_STATUS[order.status]?.label ?? order.status}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        <SectionCard title="Goods received" description="Newest first" flush>
          {receipts.length === 0 ? (
            <p className="border-t border-border px-5 py-10 text-center text-sm text-muted-foreground">Nothing received yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border border-t border-border">
              {receipts.map((receipt) => (
                <li key={receipt.id}>
                  <Link href={`/purchases/receipts/${receipt.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-muted/50">
                    <span className="min-w-0">
                      <span className="block font-semibold text-foreground">{receipt.number}</span>
                      <span className="block text-xs text-muted-foreground">
                        {dateText(receipt.receivedDate)} · {receipt.supplierName}
                        {receipt.supplierBillNo ? ` · bill ${receipt.supplierBillNo}` : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <Money paise={receipt.totalPaise} withPaise className="font-semibold text-foreground" />
                      {receipt.status === "cancelled" ? <Badge variant="neutral">Cancelled</Badge> : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </PageContainer>
  );
}
