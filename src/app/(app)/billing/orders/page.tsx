import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Plus } from "lucide-react";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { hasPermission } from "@/modules/identity";
import { listSalesOrders } from "@/modules/sales";
import { requireSession } from "@/server/auth";
import { getLanguage, getT } from "@/server/i18n";
import { billDate } from "@/shared/i18n/labels";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("orders.title") };
}

export default function OrdersPage() {
  return (
    <ProtectedPage permission="billing.view" title="Orders">
      <OrderList />
    </ProtectedPage>
  );
}

async function OrderList() {
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const [orders, canCreate] = await Promise.all([listSalesOrders(session), hasPermission(session, "billing.create")]);
  return (
    <PageContainer>
      <Link href="/billing" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("page.billing")}
      </Link>
      <PageIntro
        description={t("orders.intro")}
        actions={
          canCreate ? (
            <Link href="/billing/orders/new" className={buttonVariants({ size: "touch" })}>
              <Plus aria-hidden="true" />
              {t("orders.new")}
            </Link>
          ) : null
        }
      />
      <SectionCard title={t("orders.title")}>
        {orders.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("orders.none")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {orders.map((order) => (
              <li key={order.id}>
                <Link href={`/billing/orders/${order.id}`} className="flex flex-wrap items-center justify-between gap-2 py-3 hover:bg-muted/40">
                  <span className="flex min-w-0 flex-col">
                    <span className="font-semibold text-foreground">{order.number}</span>
                    <span className="truncate text-sm text-muted-foreground">
                      {order.customerName} · {billDate(order.orderDate, language)}
                    </span>
                  </span>
                  <Badge variant={order.status === "cancelled" ? "danger" : order.status === "delivered" ? "success" : "warning"}>{t(`orders.status.${order.status}`)}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </PageContainer>
  );
}
