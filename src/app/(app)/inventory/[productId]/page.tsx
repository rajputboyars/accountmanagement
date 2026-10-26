import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, CircleCheck } from "lucide-react";
import { setProductActiveAction } from "@/app/(app)/inventory/actions";
import { ConfirmAction } from "@/components/catalog/confirm-action";
import { PackagingSection } from "@/components/catalog/packaging-section";
import { ProductForm } from "@/components/catalog/product-form";
import { Money } from "@/components/nexora/money";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { CATALOG_MANAGE, getProduct, listCategories, listUnits } from "@/modules/catalog";
import { hasPermission } from "@/modules/identity";
import { requireSession } from "@/server/auth";
import { NotFoundError } from "@/server/errors";
import { paiseToRupeeInput } from "@/shared/money";

export const metadata: Metadata = { title: "Product" };

type Props = PageProps<"/inventory/[productId]">;

export default function ProductPage({ params, searchParams }: Props) {
  return (
    <ProtectedPage permission="inventory.view" title="Product">
      <ProductDetailView params={params} searchParams={searchParams} />
    </ProtectedPage>
  );
}

const GST_TEXT: Record<number, string> = { 0: "0% (exempt)", 500: "5%", 1200: "12%", 1800: "18%", 2800: "28%" };

async function ProductDetailView({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const [{ productId }, query] = await Promise.all([params, searchParams]);
  const session = await requireSession();
  const product = await getProduct(session, productId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });

  if (!product) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title="Product not found" description="It may have been typed wrongly, or it belongs to a different shop.">
          <Link href="/inventory" className="text-sm font-semibold text-teal-strong hover:underline">
            Back to all products
          </Link>
        </SectionCard>
      </PageContainer>
    );
  }

  const [canManage, units, categories] = await Promise.all([hasPermission(session, CATALOG_MANAGE), listUnits(session), listCategories(session)]);
  const baseUnit = units.find((unit) => unit.code === product.baseUnit);
  const saved = query.saved === "1";

  return (
    <PageContainer className="max-w-5xl">
      <Link href="/inventory" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        All products
      </Link>

      <section className="flex flex-col gap-4 rounded-2xl bg-panel p-5 text-panel-foreground sm:flex-row sm:items-end sm:justify-between sm:p-6">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-xs font-semibold tracking-wide text-panel-muted uppercase">{product.sku}</p>
          <h2 className="text-xl font-bold sm:text-2xl">{product.name}</h2>
          <p className="text-sm text-panel-muted">
            {product.categoryName ?? "No category"} · HSN {product.hsn} · GST {GST_TEXT[product.gstRateBp] ?? `${product.gstRateBp / 100}%`}
          </p>
          <div className="mt-1">{product.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="neutral">Switched off</Badge>}</div>
        </div>
        <dl className="grid grid-cols-2 gap-4 text-sm sm:text-right">
          <div>
            <dt className="text-panel-muted">Retail / {product.baseUnit}</dt>
            <dd className="text-lg font-semibold">
              <Money paise={product.retailPaise} withPaise />
            </dd>
          </div>
          <div>
            <dt className="text-panel-muted">Wholesale / {product.baseUnit}</dt>
            <dd className="text-lg font-semibold">
              <Money paise={product.wholesalePaise} withPaise />
            </dd>
          </div>
        </dl>
      </section>

      {saved ? (
        <p role="status" className="flex gap-2 rounded-xl bg-success-soft px-4 py-3 text-sm text-success">
          <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          Product saved. Add pack sizes below if you sell it by the box or bundle.
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <SectionCard title={canManage ? "Edit details" : "Details"}>
          {canManage ? (
            <ProductForm
              key={product.version}
              mode="edit"
              productId={product.id}
              version={product.version}
              initial={{
                name: product.name,
                sku: product.sku,
                barcode: product.barcode ?? "",
                categoryName: product.categoryName ?? "",
                description: product.description ?? "",
                baseUnit: product.baseUnit,
                hsn: product.hsn,
                gstRateBp: String(product.gstRateBp),
                retailPrice: paiseToRupeeInput(product.retailPaise),
                wholesalePrice: paiseToRupeeInput(product.wholesalePaise),
                costPrice: product.costPaise === null ? "" : paiseToRupeeInput(product.costPaise),
              }}
              units={units.filter((unit) => unit.isActive || unit.code === product.baseUnit).map((unit) => ({ code: unit.code, name: unit.name }))}
              categories={categories.map((category) => category.name)}
              canSeeCost={product.costVisible}
              baseUnitEditable={product.conversions.length === 0}
            />
          ) : (
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <ReadOnly label="Barcode" value={product.barcode ?? "—"} />
              <ReadOnly label="Base unit" value={product.baseUnitName} />
              <ReadOnly label="Description" value={product.description ?? "—"} wide />
            </dl>
          )}
        </SectionCard>

        <div className="flex flex-col gap-6">
          <SectionCard title="Pack sizes">
            <PackagingSection
              productId={product.id}
              baseUnit={{ code: product.baseUnit, name: product.baseUnitName, allowDecimal: baseUnit?.allowDecimal ?? false }}
              conversions={product.conversions}
              unitOptions={units.filter((unit) => unit.isActive && unit.code !== product.baseUnit).map((unit) => ({ code: unit.code, name: unit.name }))}
              canManage={canManage}
            />
          </SectionCard>

          {canManage ? (
            <SectionCard
              title={product.isActive ? "Switch off product" : "Switch product back on"}
              description={
                product.isActive
                  ? "Hides it from the product list and new bills. Its history is kept; nothing is deleted."
                  : "It will show in the product list again."
              }
            >
              <ConfirmAction
                key={String(product.isActive)}
                action={setProductActiveAction}
                fields={{ productId: product.id, active: product.isActive ? "false" : "true" }}
                label={product.isActive ? "Switch off" : "Switch on"}
                confirmLabel={product.isActive ? "Yes, switch off" : "Yes, switch on"}
                question={product.isActive ? `Switch off ${product.name}? You can switch it back on at any time.` : `Switch ${product.name} back on?`}
                destructive={product.isActive}
              />
            </SectionCard>
          ) : null}
        </div>
      </div>
    </PageContainer>
  );
}

function ReadOnly({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium text-foreground">{value}</dd>
    </div>
  );
}
