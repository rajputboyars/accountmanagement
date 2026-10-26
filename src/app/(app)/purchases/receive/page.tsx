import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PurchaseLinesForm } from "@/components/purchases/purchase-lines-form";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { getPurchaseOrder, listSuppliers, purchasableProducts } from "@/modules/purchasing";
import { requireSession } from "@/server/auth";
import { NotFoundError } from "@/server/errors";

export const metadata: Metadata = { title: "Receive goods" };

export default function ReceivePage({ searchParams }: PageProps<"/purchases/receive">) {
  return (
    <ProtectedPage permission="stock.receive" title="Receive goods">
      <Receive searchParams={searchParams} />
    </ProtectedPage>
  );
}

async function Receive({ searchParams }: { searchParams: PageProps<"/purchases/receive">["searchParams"] }) {
  const params = await searchParams;
  const orderId = String(params.order ?? "");
  const session = await requireSession();
  const order = orderId
    ? await getPurchaseOrder(session, orderId).catch((error: unknown) => {
        if (error instanceof NotFoundError) return null;
        throw error;
      })
    : null;
  const [suppliers, products] = await Promise.all([listSuppliers(session), order ? Promise.resolve([]) : purchasableProducts(session).catch(() => [])]);

  return (
    <PageContainer className="max-w-5xl">
      <Link href={order ? `/purchases/orders/${order.id}` : "/purchases"} className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {order ? order.number : "Purchases"}
      </Link>
      {order && !order.canReceive ? (
        <SectionCard title={`Nothing more to receive on ${order.number}`} description="It is fully received, closed or cancelled.">
          <Link href={`/purchases/orders/${order.id}`} className="text-sm font-semibold text-teal-strong hover:underline">
            View the order
          </Link>
        </SectionCard>
      ) : (
        <SectionCard
          title={order ? `Receive against ${order.number}` : "Receive goods"}
          description={order ? `From ${order.supplier.name}. Enter what actually arrived and the cost on the supplier's bill.` : "For goods that arrived without an order. Enter the supplier's bill as it is."}
        >
          <PurchaseLinesForm
            mode="receipt"
            defaultSupplierId={suppliers.some((supplier) => supplier.id === params.supplier) ? String(params.supplier) : ""}
            suppliers={suppliers.map((supplier) => ({ id: supplier.id, name: supplier.name }))}
            products={products}
            order={order ? { id: order.id, supplierName: order.supplier.name, lines: order.lines.filter((line) => line.leftBase !== "0") } : undefined}
          />
        </SectionCard>
      )}
    </PageContainer>
  );
}
