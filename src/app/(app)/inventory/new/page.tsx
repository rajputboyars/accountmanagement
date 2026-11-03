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
import { getT } from "@/server/i18n";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.addProduct") };
}

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
  const t = await getT();
  const [units, categories, settings] = await Promise.all([listUnits(session), listCategories(session), getBusinessSettings(session)]);
  return (
    <PageContainer className="max-w-4xl">
      <Link href="/inventory" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("inventory.allProducts")}
      </Link>
      <SectionCard title={t("page.addProduct")} anchorId="add-product" description={t("inventory.addHelpShort")}>
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
