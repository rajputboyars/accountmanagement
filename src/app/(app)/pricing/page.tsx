import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Search, Tags } from "lucide-react";
import { AddRuleForm, RuleList } from "@/components/pricing/rule-section";
import { Money } from "@/components/nexora/money";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { listAllProductRules, listPricingCustomers, listPricingProducts } from "@/modules/pricing";
import { requireSession } from "@/server/auth";
import { getLanguage, getT } from "@/server/i18n";
import type { MessageKey } from "@/shared/i18n";
import { unitName, unitShort } from "@/shared/i18n/unit-labels";
import { formatPaise } from "@/shared/money";
import { customerOptions, ruleViews } from "./view-models";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("nav.pricing.label") };
}

type Search = PageProps<"/pricing">["searchParams"];

export default function PricingPage({ searchParams }: PageProps<"/pricing">) {
  return (
    <ProtectedPage permission="pricing.edit" title="Smart Pricing" guide="pricing">
      <PricingList searchParams={searchParams} />
    </ProtectedPage>
  );
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

const ORDER: MessageKey[] = ["pricing.step1", "pricing.step2", "pricing.step3", "pricing.step4", "pricing.step5"];

async function PricingList({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const q = one(params.q).trim();
  const page = Math.max(1, Number.parseInt(one(params.page), 10) || 1);
  const [result, allRules, customers] = await Promise.all([listPricingProducts(session, { q, page }), listAllProductRules(session), listPricingCustomers(session)]);
  const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
  const pageHref = (target: number) => {
    const next = new URLSearchParams();
    if (q) next.set("q", q);
    if (target > 1) next.set("page", String(target));
    const query = next.toString();
    return query ? `/pricing?${query}` : "/pricing";
  };

  return (
    <PageContainer>
      <PageIntro description={t("pricing.intro")} />

      <section className="grid gap-5 rounded-2xl bg-panel p-5 text-panel-foreground max-md:order-last sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="flex flex-col gap-2">
          <span className="grid size-11 place-items-center rounded-xl bg-panel-foreground/10">
            <Tags className="size-5" aria-hidden="true" />
          </span>
          <h2 className="text-xl font-bold">{t("pricing.howChosen")}</h2>
          <p className="text-sm text-panel-muted">{t("pricing.howChosenHelp")}</p>
        </div>
        <ol className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          {ORDER.map((step, index) => (
            <li key={step} className="flex gap-3 rounded-xl bg-panel-2 px-3 py-2.5">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-panel-foreground/15 text-xs font-bold tabular-nums">{index + 1}</span>
              <span>{t(step)}</span>
            </li>
          ))}
        </ol>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <SectionCard title={t(q ? "pricing.matching" : "common.products")} description={t(result.total === 1 ? "pricing.productCountOne" : "pricing.productCount", { count: result.total.toLocaleString("en-IN") })} flush>
          <form role="search" action="/pricing" className="flex gap-2 px-5 pb-3">
            <label className="relative flex-1">
              <span className="sr-only">{t("pricing.searchProducts")}</span>
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input name="q" defaultValue={q} placeholder={t("pricing.searchPlaceholder")} className="h-11 pl-9" />
            </label>
            <button type="submit" className={buttonVariants({ size: "touch", variant: "outline" })}>
              {t("common.search")}
            </button>
          </form>
          {result.items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
              <p className="font-semibold text-foreground">{t(q ? "pricing.noMatch" : "pricing.noProducts")}</p>
              <p className="text-sm text-muted-foreground">{t(q ? "pricing.tryAnother" : "pricing.addFirst")}</p>
              <Link href={q ? "/pricing" : "/inventory/new"} className={buttonVariants({ variant: "outline", size: "touch" })}>
                {t(q ? "pricing.clearSearch" : "pricing.addProduct")}
              </Link>
            </div>
          ) : (
            <ul className="flex flex-col divide-y divide-border border-t border-border">
              {result.items.map((product) => (
                <li key={product.id}>
                  <Link href={`/pricing/${product.id}`} className="flex flex-col gap-1.5 px-5 py-3 hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <span className="min-w-0">
                      <span className="block font-semibold text-foreground">{product.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {product.sku} · {t("pricing.perUnit", { unit: unitName(t, product.baseUnit, product.baseUnitName).toLowerCase() })}
                      </span>
                      {product.slabs.length > 0 ? (
                        <span className="mt-0.5 block text-xs text-teal-strong">
                          {product.slabs.map((slab, index) => (
                            <span key={slab.minQty}>
                              {index > 0 ? " · " : ""}
                              <span className="whitespace-nowrap">
                                {slab.minQty}+ {unitShort(t, product.baseUnit)} {formatPaise(slab.pricePaise, { withPaise: true })}
                              </span>
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                      <span>
                        <span className="text-xs text-muted-foreground">{t("common.retail")} </span>
                        <Money paise={product.retailPaise} withPaise className="font-medium" />
                      </span>
                      <span>
                        <span className="text-xs text-muted-foreground">{t("common.wholesale")} </span>
                        <Money paise={product.wholesalePaise} withPaise className="font-medium" />
                      </span>
                      {product.ruleCount > 0 ? <Badge variant="info">{t("pricing.specialCount", { count: product.ruleCount })}</Badge> : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {lastPage > 1 ? (
            <nav aria-label={t("common.pages")} className="flex items-center justify-between gap-3 border-t border-border px-5 pt-3">
              <p className="text-xs text-muted-foreground">
                {t("common.pageOf", { page: result.page, last: lastPage })}
              </p>
              <div className="flex gap-2">
                {result.page > 1 ? (
                  <Link href={pageHref(result.page - 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
                    <ChevronLeft aria-hidden="true" />
                    {t("common.previous")}
                  </Link>
                ) : null}
                {result.page < lastPage ? (
                  <Link href={pageHref(result.page + 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
                    {t("common.next")}
                    <ChevronRight aria-hidden="true" />
                  </Link>
                ) : null}
              </div>
            </nav>
          ) : null}
        </SectionCard>

        <SectionCard title={t("pricing.allProductsTitle")} description={t("pricing.allProductsHelp")}>
          <div className="flex flex-col gap-4">
            <RuleList rules={ruleViews(t, language, allRules, undefined, null).map((rule) => ({ ...rule, appliesToAll: false }))} productId="" emptyText={t("pricing.noAllDiscount")} />
            <AddRuleForm customers={customerOptions(t, language, customers)} product={null} />
          </div>
        </SectionCard>
      </div>
    </PageContainer>
  );
}
