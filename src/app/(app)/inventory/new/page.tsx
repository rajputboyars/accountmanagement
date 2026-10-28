import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ProductForm } from "@/components/catalog/product-form";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { listCategories, listUnits } from "@/modules/catalog";
import { getBusinessSettings } from "@/modules/settings";
import { requireSession } from "@/server/auth";

export const metadata: Metadata = { title: "Add product" };

export default function NewProductPage() {
  // Adding products changes selling prices, so it needs the owner's pricing permission.
  return (
    <ProtectedPage permission="pricing.edit" title="Add product">
      <NewProduct />
    </ProtectedPage>
  );
}

async function NewProduct() {
  const session = await requireSession();
  const [units, categories, settings] = await Promise.all([listUnits(session), listCategories(session), getBusinessSettings(session)]);
  return (
    <PageContainer className="max-w-4xl">
      <Link href="/inventory" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        All products
      </Link>
      <SectionCard title="Add product" description="You can add pack sizes such as Box or Bundle after saving.">
        <ProductForm
          mode="create"
          initial={{ name: "", sku: "", barcode: "", categoryName: "", description: "", baseUnit: "pc", hsn: "", gstRateBp: "1800", retailPrice: "", wholesalePrice: "", costPrice: "", reorderLevel: "10" }}
          units={units.map((unit) => ({ code: unit.code, name: unit.name }))}
          categories={categories.map((category) => category.name)}
          canSeeCost
          baseUnitEditable
          gstRates={settings.gst.gstRatesBp}
        />
      </SectionCard>
    </PageContainer>
  );
}
