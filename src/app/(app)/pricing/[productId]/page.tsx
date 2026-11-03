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
import { getLanguage, getT } from "@/server/i18n";
import { packLabel, unitName, unitShort } from "@/shared/i18n/unit-labels";
import { customerOptions, marginText, money, ruleViews, slabViews } from "../view-models";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("pricing.productPricing") };
}

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
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const product = await getPricingProduct(session, productId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!product) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title={t("pricing.notFound")} description={t("pricing.notFoundHelp")}>
          <Link href="/pricing" className="text-sm font-semibold text-teal-strong hover:underline">
            {t("pricing.backTo", { page: t("nav.pricing.label") })}
          </Link>
        </SectionCard>
      </PageContainer>
    );
  }

  const [slabs, rules, customers] = await Promise.all([listSlabs(session, product.id), listRulesForProduct(session, product.id), listPricingCustomers(session)]);
  const slabView = slabViews(t, slabs, product.baseUnit, product.baseAllowsDecimal, product.costPaise);
  const options = customerOptions(t, language, customers);
  const baseShort = unitShort(t, product.baseUnit);
  const baseName = unitName(t, product.baseUnit, product.baseUnitName);
  const units = [
    { code: product.baseUnit, label: baseName === baseShort ? baseName : `${baseName} (${baseShort})` },
    ...product.saleUnits.map((unit) => ({ code: unit.code, label: `${unitName(t, unit.code, unit.name)} (${unit.factor} ${baseShort})` })),
  ];
  const prices = [
    { label: t("common.retail"), paise: product.retailPaise },
    { label: t("common.wholesale"), paise: product.wholesalePaise },
  ];

  return (
    <PageContainer className="max-w-6xl">
      <Link href="/pricing" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("nav.pricing.label")}
      </Link>

      <section className="flex flex-col gap-4 rounded-2xl bg-panel p-5 text-panel-foreground sm:p-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-xs font-semibold tracking-wide text-panel-muted uppercase">{product.sku}</p>
          <h2 className="text-xl font-bold sm:text-2xl">{product.name}</h2>
          <p className="text-sm text-panel-muted">
            {t("pricing.pricesPer", { unit: baseName.toLowerCase() })}
            {product.saleUnits.length > 0 ? ` · ${t("pricing.alsoSoldAs", { packs: product.saleUnits.map((unit) => packLabel(t, unit.code, unit.name, unit.factor).toLowerCase()).join(", ") })}` : ""}
          </p>
          {!product.isActive ? (
            <div className="mt-1">
              <Badge variant="neutral">{t("pricing.switchedOff")}</Badge>
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
                {product.costPaise !== null ? <dd className="text-xs text-panel-muted">{t("pricing.margin", { value: marginText(price.paise, product.costPaise) ?? "" })}</dd> : null}
              </div>
            ))}
            {product.costVisible ? (
              <div>
                <dt className="text-panel-muted">{t("pricing.cost")}</dt>
                <dd className="text-lg font-semibold">{product.costPaise === null ? "—" : <Money paise={product.costPaise} withPaise />}</dd>
                {product.costPaise === null ? <dd className="text-xs text-panel-muted">{t("pricing.costNotSet")}</dd> : null}
              </div>
            ) : null}
          </dl>
          <Link href={`/inventory/${product.id}`} className={buttonVariants({ variant: "outline", size: "touch", className: "border-panel-foreground/20 bg-panel-foreground/10 text-panel-foreground hover:bg-panel-foreground/20" })}>
            <Pencil aria-hidden="true" />
            {t("pricing.editPrices")}
          </Link>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <SectionCard title={t("pricing.slabsTitle")} description={t("pricing.slabsDescription")}>
            <SlabSection
              productId={product.id}
              baseUnit={product.baseUnit}
              allowDecimal={product.baseAllowsDecimal}
              wholesaleText={money(product.wholesalePaise)}
              baselineLabel={slabView.baseline}
              slabs={slabView.slabs}
            />
          </SectionCard>
          <SectionCard title={t("pricing.customerPrices")} description={t("pricing.customerPricesHelp")}>
            <div className="flex flex-col gap-4">
              <RuleList rules={ruleViews(t, language, rules, product.baseUnit, product.costPaise)} productId={product.id} emptyText={t("pricing.noCustomerPrice")} />
              <AddRuleForm customers={options} product={{ id: product.id, baseUnit: product.baseUnit }} />
            </div>
          </SectionCard>
        </div>
        <SectionCard title={t("pricing.priceCheck")} description={t("pricing.priceCheckHelp")} className="self-start lg:sticky lg:top-20">
          {product.isActive ? (
            <PriceCheck productId={product.id} units={units} customers={options} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("pricing.switchOnFirst")}</p>
          )}
        </SectionCard>
      </div>
    </PageContainer>
  );
}
