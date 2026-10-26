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
import { formatPaise } from "@/shared/money";
import { customerOptions, ruleViews } from "./view-models";

export const metadata: Metadata = { title: "Smart Pricing" };

type Search = PageProps<"/pricing">["searchParams"];

export default function PricingPage({ searchParams }: PageProps<"/pricing">) {
  return (
    <ProtectedPage permission="pricing.edit" title="Smart Pricing">
      <PricingList searchParams={searchParams} />
    </ProtectedPage>
  );
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

const ORDER = [
  "Retail bills use the retail price. Nothing else applies.",
  "Wholesale bills start from the wholesale price.",
  "A quantity slab replaces it once the quantity reaches the slab.",
  "A customer's special price is used only if it is lower.",
  "A customer's % off comes last, rounded to the paisa.",
];

async function PricingList({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const session = await requireSession();
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
      <PageIntro description="Wholesale quantity slabs and customer-specific prices for each product, and a price check that shows exactly how a rate is worked out." />

      <section className="grid gap-5 rounded-2xl bg-panel p-5 text-panel-foreground max-md:order-last sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="flex flex-col gap-2">
          <span className="grid size-11 place-items-center rounded-xl bg-panel-foreground/10">
            <Tags className="size-5" aria-hidden="true" />
          </span>
          <h2 className="text-xl font-bold">How a price is chosen</h2>
          <p className="text-sm text-panel-muted">The same steps run for the price check here and, later, on every bill. Slabs and minimums count the base unit, so 3 boxes of 50 is 150 pieces.</p>
        </div>
        <ol className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          {ORDER.map((step, index) => (
            <li key={step} className="flex gap-3 rounded-xl bg-panel-2 px-3 py-2.5">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-panel-foreground/15 text-xs font-bold tabular-nums">{index + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <SectionCard title={q ? "Matching products" : "Products"} description={`${result.total.toLocaleString("en-IN")} active ${result.total === 1 ? "product" : "products"}`} flush>
          <form role="search" action="/pricing" className="flex gap-2 px-5 pb-3">
            <label className="relative flex-1">
              <span className="sr-only">Search products</span>
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input name="q" defaultValue={q} placeholder="Search by name, code or barcode" className="h-11 pl-9" />
            </label>
            <button type="submit" className={buttonVariants({ size: "touch", variant: "outline" })}>
              Search
            </button>
          </form>
          {result.items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
              <p className="font-semibold text-foreground">{q ? "No products match" : "No products yet"}</p>
              <p className="text-sm text-muted-foreground">{q ? "Try another word." : "Add products in Products & Inventory first."}</p>
              <Link href={q ? "/pricing" : "/inventory/new"} className={buttonVariants({ variant: "outline", size: "touch" })}>
                {q ? "Clear search" : "Add a product"}
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
                        {product.sku} · per {product.baseUnitName.toLowerCase()}
                      </span>
                      {product.slabs.length > 0 ? (
                        <span className="mt-0.5 block text-xs text-teal-strong">
                          {product.slabs.map((slab, index) => (
                            <span key={slab.minQty} className="whitespace-nowrap">
                              {index > 0 ? " · " : ""}
                              {slab.minQty}+ {product.baseUnit} {formatPaise(slab.pricePaise, { withPaise: true })}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                      <span>
                        <span className="text-xs text-muted-foreground">Retail </span>
                        <Money paise={product.retailPaise} withPaise className="font-medium" />
                      </span>
                      <span>
                        <span className="text-xs text-muted-foreground">Wholesale </span>
                        <Money paise={product.wholesalePaise} withPaise className="font-medium" />
                      </span>
                      {product.ruleCount > 0 ? <Badge variant="info">{product.ruleCount} special</Badge> : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {lastPage > 1 ? (
            <nav aria-label="Pages" className="flex items-center justify-between gap-3 border-t border-border px-5 pt-3">
              <p className="text-xs text-muted-foreground">
                Page {result.page} of {lastPage}
              </p>
              <div className="flex gap-2">
                {result.page > 1 ? (
                  <Link href={pageHref(result.page - 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
                    <ChevronLeft aria-hidden="true" />
                    Previous
                  </Link>
                ) : null}
                {result.page < lastPage ? (
                  <Link href={pageHref(result.page + 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
                    Next
                    <ChevronRight aria-hidden="true" />
                  </Link>
                ) : null}
              </div>
            </nav>
          ) : null}
        </SectionCard>

        <SectionCard title="Discounts on all products" description="A customer's % off on every wholesale bill. A % off set on one product replaces it for that product.">
          <div className="flex flex-col gap-4">
            <RuleList rules={ruleViews(allRules, undefined, null).map((rule) => ({ ...rule, appliesToAll: false }))} productId="" emptyText="No customer has a discount on all products yet." />
            <AddRuleForm customers={customerOptions(customers)} product={null} />
          </div>
        </SectionCard>
      </div>
    </PageContainer>
  );
}
