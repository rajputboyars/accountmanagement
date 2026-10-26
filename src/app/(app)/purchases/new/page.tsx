import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PurchaseLinesForm } from "@/components/purchases/purchase-lines-form";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { listSuppliers, purchasableProducts } from "@/modules/purchasing";
import { requireSession } from "@/server/auth";

export const metadata: Metadata = { title: "New purchase order" };

export default function NewOrderPage() {
  return (
    <ProtectedPage permission="purchases.edit" title="New purchase order">
      <NewOrder />
    </ProtectedPage>
  );
}

async function NewOrder() {
  const session = await requireSession();
  const [suppliers, products] = await Promise.all([listSuppliers(session), purchasableProducts(session)]);
  return (
    <PageContainer className="max-w-5xl">
      <Link href="/purchases" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Purchases
      </Link>
      <SectionCard title="New purchase order" description="What you are ordering and the agreed cost per unit. Nothing changes in stock or accounts until the goods arrive.">
        {suppliers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Add a supplier first on the <Link href="/suppliers" className="font-semibold text-teal-strong underline">Suppliers</Link> page.
          </p>
        ) : (
          <PurchaseLinesForm mode="order" suppliers={suppliers.map((supplier) => ({ id: supplier.id, name: supplier.name }))} products={products} />
        )}
      </SectionCard>
    </PageContainer>
  );
}
