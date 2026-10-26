import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Pencil } from "lucide-react";
import { PriceCheck } from "@/components/pricing/price-check";
import { AddRuleForm, RuleList } from "@/components/pricing/rule-section";
import { SlabSection } from "@/components/pricing/slab-section";
import { Money } from "@/components/nexora/money";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { getPricingProduct, listPricingCustomers, listRulesForProduct, listSlabs } from "@/modules/pricing";
import { requireSession } from "@/server/auth";
import { NotFoundError } from "@/server/errors";
import { customerOptions, marginText, money, ruleViews, slabViews } from "../view-models";

export const metadata: Metadata = { title: "Product pricing" };

type Props = PageProps<"/pricing/[productId]">;

export default function ProductPricingPage({ params }: Props) {
  return (
    <ProtectedPage permission="pricing.edit" title="Smart Pricing">
      <ProductPricing params={params} />
    </ProtectedPage>
  );
}

async function ProductPricing({ params }: Pick<Props, "params">) {
  const { productId } = await params;
  const session = await requireSession();
  const product = await getPricingProduct(session, productId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!product) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title="Product not found" description="It may have been typed wrongly, or it belongs to a different shop.">
          <Link href="/pricing" className="text-sm font-semibold text-teal-strong hover:underline">
            Back to Smart Pricing
          </Link>
        </SectionCard>
      </PageContainer>
    );
  }

  const [slabs, rules, customers] = await Promise.all([listSlabs(session, product.id), listRulesForProduct(session, product.id), listPricingCustomers(session)]);
  const slabView = slabViews(slabs, product.baseUnit, product.baseAllowsDecimal, product.costPaise);
  const options = customerOptions(customers);
  const units = [
    { code: product.baseUnit, label: `${product.baseUnitName} (${product.baseUnit})` },
    ...product.saleUnits.map((unit) => ({ code: unit.code, label: `${unit.name} (${unit.factor} ${product.baseUnit})` })),
  ];
  const prices = [
    { label: "Retail", paise: product.retailPaise },
    { label: "Wholesale", paise: product.wholesalePaise },
  ];

  return (
    <PageContainer className="max-w-6xl">
      <Link href="/pricing" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Smart Pricing
      </Link>

      <section className="flex flex-col gap-4 rounded-2xl bg-panel p-5 text-panel-foreground sm:p-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-xs font-semibold tracking-wide text-panel-muted uppercase">{product.sku}</p>
          <h2 className="text-xl font-bold sm:text-2xl">{product.name}</h2>
          <p className="text-sm text-panel-muted">
            Prices per {product.baseUnitName.toLowerCase()}, before GST
            {product.saleUnits.length > 0 ? ` · also sold as ${product.saleUnits.map((unit) => `${unit.name.toLowerCase()} of ${unit.factor}`).join(", ")}` : ""}
          </p>
          {!product.isActive ? (
            <div className="mt-1">
              <Badge variant="neutral">Switched off: not priced on bills</Badge>
            </div>
          ) : null}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
            {prices.map((price) => (
              <div key={price.label}>
                <dt className="text-panel-muted">{price.label}</dt>
                <dd className="text-lg font-semibold">
                  <Money paise={price.paise} withPaise />
                </dd>
                {product.costPaise !== null ? <dd className="text-xs text-panel-muted">Margin {marginText(price.paise, product.costPaise)}</dd> : null}
              </div>
            ))}
            {product.costVisible ? (
              <div>
                <dt className="text-panel-muted">Cost</dt>
                <dd className="text-lg font-semibold">{product.costPaise === null ? "—" : <Money paise={product.costPaise} withPaise />}</dd>
                {product.costPaise === null ? <dd className="text-xs text-panel-muted">Not set: margins hidden</dd> : null}
              </div>
            ) : null}
          </dl>
          <Link href={`/inventory/${product.id}`} className={buttonVariants({ variant: "outline", size: "touch", className: "border-panel-foreground/20 bg-panel-foreground/10 text-panel-foreground hover:bg-panel-foreground/20" })}>
            <Pencil aria-hidden="true" />
            Edit list prices
          </Link>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <SectionCard title="Quantity slabs" description="Wholesale price list">
            <SlabSection
              productId={product.id}
              baseUnit={product.baseUnit}
              allowDecimal={product.baseAllowsDecimal}
              wholesaleText={money(product.wholesalePaise)}
              baselineLabel={slabView.baseline}
              slabs={slabView.slabs}
            />
          </SectionCard>
          <SectionCard title="Customer prices" description="Special prices and % off for one customer">
            <div className="flex flex-col gap-4">
              <RuleList rules={ruleViews(rules, product.baseUnit, product.costPaise)} productId={product.id} emptyText="No customer has a special price for this product." />
              <AddRuleForm customers={options} product={{ id: product.id, baseUnit: product.baseUnit }} />
            </div>
          </SectionCard>
        </div>
        <SectionCard title="Price check" description="See the exact rate a bill would use. Nothing is saved." className="self-start lg:sticky lg:top-20">
          {product.isActive ? (
            <PriceCheck productId={product.id} units={units} customers={options} />
          ) : (
            <p className="text-sm text-muted-foreground">Switch the product on in Products & Inventory to check its price.</p>
          )}
        </SectionCard>
      </div>
    </PageContainer>
  );
}
