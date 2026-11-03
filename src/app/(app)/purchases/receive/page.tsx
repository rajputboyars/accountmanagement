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
import { getT } from "@/server/i18n";
import { packLabel, unitName, unitShort } from "@/shared/i18n/unit-labels";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.receiveGoods") };
}

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
  const t = await getT();
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
        {order ? order.number : t("page.purchases")}
      </Link>
      {order && !order.canReceive ? (
        <SectionCard title={t("purchases.nothingToReceive", { number: order.number })} anchorId="nothing-to-receive" description={t("purchases.nothingToReceiveHelp")}>
          <Link href={`/purchases/orders/${order.id}`} className="text-sm font-semibold text-teal-strong hover:underline">
            {t("purchases.viewOrder")}
          </Link>
        </SectionCard>
      ) : (
        <SectionCard
          title={order ? t("purchases.receiveAgainst", { number: order.number }) : t("page.receiveGoods")}
          anchorId="receive-goods"
          description={order ? t("purchases.fromSupplierHelp", { name: order.supplier.name }) : t("purchases.directHelp")}
        >
          <PurchaseLinesForm
            mode="receipt"
            defaultSupplierId={suppliers.some((supplier) => supplier.id === params.supplier) ? String(params.supplier) : ""}
            suppliers={suppliers.map((supplier) => ({ id: supplier.id, name: supplier.name }))}
            products={products.map((product) => ({ ...product, units: product.units.map((unit) => ({ code: unit.code, label: unit.factor ? packLabel(t, unit.code, unit.name, unit.factor) : unitName(t, unit.code, unit.name) })) }))}
            order={order ? { id: order.id, supplierName: order.supplier.name, lines: order.lines.filter((line) => line.leftBase !== "0").map((line) => ({ ...line, unitLabel: unitShort(t, line.unit), baseUnitLabel: unitShort(t, line.baseUnit) })) } : undefined}
          />
        </SectionCard>
      )}
    </PageContainer>
  );
}
