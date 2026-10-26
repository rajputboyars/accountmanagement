import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { OpeningStockForm } from "@/components/inventory/opening-stock-form";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { listOpeningCandidates } from "@/modules/inventory";
import { requireSession } from "@/server/auth";
import { indiaDate } from "@/shared/financial-year";

export const metadata: Metadata = { title: "Opening stock" };

export default function OpeningStockPage() {
  return (
    <ProtectedPage permission="stock.opening" title="Opening stock">
      <OpeningStock />
    </ProtectedPage>
  );
}

async function OpeningStock() {
  const session = await requireSession();
  const { products, canEnterCost } = await listOpeningCandidates(session);
  return (
    <PageContainer className="max-w-5xl">
      <Link href="/inventory/stock" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Stock
      </Link>
      <section className="flex flex-col gap-2 rounded-2xl bg-panel p-5 text-panel-foreground sm:p-6">
        <h2 className="text-xl font-bold">Enter opening stock</h2>
        <p className="max-w-2xl text-sm text-panel-muted">
          Count what is on your shelves before you start billing in Nexora, and enter it here once. You can count in boxes or bundles: it is converted to the product&apos;s base unit using that product&apos;s own pack size. After this,
          changes go through stock adjustments.
        </p>
        <p className="text-sm text-panel-muted">
          {products.length.toLocaleString("en-IN")} {products.length === 1 ? "product has" : "products have"} no stock entered yet.
        </p>
      </section>
      <SectionCard title="Products and quantities" description="Everything is checked first and saved together: if one line has a problem, nothing is saved.">
        <OpeningStockForm products={products} canEnterCost={canEnterCost} today={indiaDate()} />
      </SectionCard>
    </PageContainer>
  );
}
