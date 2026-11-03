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
import { getLanguage, getT } from "@/server/i18n";
import { billDate } from "@/shared/i18n/labels";

const item = getNavItem("purchases");

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.purchases") };
}

export default function PurchasesPage() {
  return (
    <ProtectedPage permission="purchases.view" title={item.label} guide="purchases">
      <Purchases />
    </ProtectedPage>
  );
}

async function Purchases() {
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const dateText = (value: string) => billDate(value, language);
  const [orders, receipts, canOrder, canReceive] = await Promise.all([listPurchaseOrders(session), listGoodsReceipts(session), hasPermission(session, PURCHASES_EDIT), hasPermission(session, STOCK_RECEIVE)]);
  const open = orders.filter((order) => order.status === "ordered" || order.status === "partially_received");

  return (
    <PageContainer>
      <PageIntro
        description={t("purchases.intro")}
        actions={
          <>
            {canOrder ? (
              <Link href="/purchases/new" className={buttonVariants({ variant: "outline", size: "touch" })}>
                <ClipboardList aria-hidden="true" />
                {t("purchases.newOrder")}
              </Link>
            ) : null}
            {canReceive ? (
              <Link href="/purchases/receive" className={buttonVariants({ size: "touch" })}>
                <PackagePlus aria-hidden="true" />
                {t("suppliers.receiveGoods")}
              </Link>
            ) : null}
          </>
        }
      />
      <section className="grid grid-cols-2 gap-3 rounded-2xl bg-panel p-5 text-panel-foreground sm:grid-cols-3 sm:p-6">
        <div>
          <p className="text-2xl font-bold tabular-nums">{open.length}</p>
          <p className="text-xs text-panel-muted">{t("purchases.waiting")}</p>
        </div>
        <div>
          <p className="text-2xl font-bold tabular-nums">{orders.filter((order) => order.status === "partially_received").length}</p>
          <p className="text-xs text-panel-muted">{t("purchases.receivedShort")}</p>
        </div>
        <div>
          <p className="text-2xl font-bold tabular-nums">{receipts.filter((receipt) => receipt.status === "received").length}</p>
          <p className="text-xs text-panel-muted">{t("purchases.receiptsCount")}</p>
        </div>
      </section>
      <div className="grid gap-6 xl:grid-cols-2">
        <SectionCard help="purchaseOrder" title={t("purchases.orders")} anchorId="purchase-orders" description={t("purchases.newestFirst")} flush>
          {orders.length === 0 ? (
            <p className="border-t border-border px-5 py-10 text-center text-sm text-muted-foreground">{t("purchases.noOrders")}</p>
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
                    <Badge variant={ORDER_STATUS[order.status]?.variant ?? "neutral"}>{ORDER_STATUS[order.status] ? t(ORDER_STATUS[order.status]!.label) : order.status}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        <SectionCard help="goodsReceived" title={t("purchases.received")} anchorId="goods-received" description={t("purchases.newestFirst")} flush>
          {receipts.length === 0 ? (
            <p className="border-t border-border px-5 py-10 text-center text-sm text-muted-foreground">{t("suppliers.nothingReceived")}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border border-t border-border">
              {receipts.map((receipt) => (
                <li key={receipt.id}>
                  <Link href={`/purchases/receipts/${receipt.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-muted/50">
                    <span className="min-w-0">
                      <span className="block font-semibold text-foreground">{receipt.number}</span>
                      <span className="block text-xs text-muted-foreground">
                        {dateText(receipt.receivedDate)} · {receipt.supplierName}
                        {receipt.supplierBillNo ? ` · ${t("suppliers.billNumber", { number: receipt.supplierBillNo })}` : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <Money paise={receipt.totalPaise} withPaise className="font-semibold text-foreground" />
                      {receipt.status === "cancelled" ? <Badge variant="neutral">{t("purchases.status.cancelled")}</Badge> : null}
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
