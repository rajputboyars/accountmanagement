import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PurchaseLinesForm } from "@/components/purchases/purchase-lines-form";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { listSuppliers, purchasableProducts } from "@/modules/purchasing";
import { requireSession } from "@/server/auth";
import { getT } from "@/server/i18n";
import { packLabel, unitName } from "@/shared/i18n/unit-labels";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.newOrder") };
}

export default function NewOrderPage() {
  return (
    <ProtectedPage permission="purchases.edit" title="New purchase order">
      <NewOrder />
    </ProtectedPage>
  );
}

async function NewOrder() {
  const session = await requireSession();
  const t = await getT();
  const [suppliers, products] = await Promise.all([listSuppliers(session), purchasableProducts(session)]);
  return (
    <PageContainer className="max-w-5xl">
      <Link href="/purchases" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("page.purchases")}
      </Link>
      <SectionCard title={t("page.newOrder")} anchorId="new-order" description={t("purchases.newOrderHelp")}>
        {suppliers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("purchases.addSupplierFirst")} <Link href="/suppliers" className="font-semibold text-teal-strong underline">{t("page.suppliers")}</Link> {t("purchases.addSupplierFirstEnd")}
          </p>
        ) : (
          <PurchaseLinesForm mode="order" suppliers={suppliers.map((supplier) => ({ id: supplier.id, name: supplier.name }))} products={products.map((product) => ({ ...product, units: product.units.map((unit) => ({ code: unit.code, label: unit.factor ? packLabel(t, unit.code, unit.name, unit.factor) : unitName(t, unit.code, unit.name) })) }))} />
        )}
      </SectionCard>
    </PageContainer>
  );
}
