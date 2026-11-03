import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, PackagePlus, PackageSearch, Search } from "lucide-react";
import { CatalogTabs } from "@/components/catalog/catalog-tabs";
import { Money } from "@/components/nexora/money";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getNavItem } from "@/config/navigation";
import { CATALOG_MANAGE, listCategories, listProducts, type ProductListItem, type ProductStatusFilter } from "@/modules/catalog";
import { hasPermission } from "@/modules/identity";
import { requireSession } from "@/server/auth";
import { getT } from "@/server/i18n";
import type { Translate } from "@/shared/i18n";
import { unitName, unitShort } from "@/shared/i18n/unit-labels";
import { selectClass } from "@/components/catalog/form-bits";

const item = getNavItem("inventory");

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.inventory") };
}

type Search = PageProps<"/inventory">["searchParams"];

export default function InventoryPage({ searchParams }: PageProps<"/inventory">) {
  return (
    <ProtectedPage permission="inventory.view" title={item.label} guide="inventory">
      <ProductList searchParams={searchParams} />
    </ProtectedPage>
  );
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

function packSummary(t: Translate, product: ProductListItem) {
  return product.conversions.map((conversion, index) => (
    <span key={conversion.id} className="whitespace-nowrap">
      {index > 0 ? " · " : ""}{t("inventory.packLine", { unit: unitName(t, conversion.unit, conversion.unitName), factor: conversion.factor, base: unitShort(t, product.baseUnit) })}
    </span>
  ));
}

async function ProductList({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const session = await requireSession();
  const t = await getT();
  const q = one(params.q).trim();
  const statusParam = one(params.status);
  const status: ProductStatusFilter = statusParam === "inactive" || statusParam === "all" ? statusParam : "active";
  const categoryId = one(params.category);
  const page = Math.max(1, Number.parseInt(one(params.page), 10) || 1);

  const [result, categories, canManage] = await Promise.all([
    listProducts(session, { q, status, categoryId: categoryId || undefined, page }),
    listCategories(session),
    hasPermission(session, CATALOG_MANAGE),
  ]);
  const filtered = q !== "" || categoryId !== "" || status !== "active";
  const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
  const pageHref = (target: number) => {
    const next = new URLSearchParams();
    if (q) next.set("q", q);
    if (status !== "active") next.set("status", status);
    if (categoryId) next.set("category", categoryId);
    if (target > 1) next.set("page", String(target));
    const query = next.toString();
    return query ? `/inventory?${query}` : "/inventory";
  };

  return (
    <PageContainer>
      <PageIntro
        description={t("inventory.intro")}
        actions={
          canManage ? (
            <Link href="/inventory/new" className={buttonVariants({ size: "touch" })}>
              <PackagePlus aria-hidden="true" />
              {t("inventory.add")}
            </Link>
          ) : null
        }
      />
      <CatalogTabs current="products" />

      <form role="search" action="/inventory" className="grid grid-cols-2 gap-3 rounded-2xl border border-border bg-card p-4 sm:grid-cols-[minmax(0,1fr)_12rem_10rem_auto]">
        <label className="relative col-span-2 sm:col-span-1">
          <span className="sr-only">{t("inventory.search")}</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input name="q" defaultValue={q} placeholder={t("inventory.searchFull")} className="h-11 pl-9" />
        </label>
        <label>
          <span className="sr-only">{t("common.category")}</span>
          <select name="category" defaultValue={categoryId} className={selectClass}>
            <option value="">{t("common.allCategories")}</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">{t("common.status")}</span>
          <select name="status" defaultValue={status} className={selectClass}>
            <option value="active">{t("common.active")}</option>
            <option value="inactive">{t("common.switchedOff")}</option>
            <option value="all">{t("common.all")}</option>
          </select>
        </label>
        <button type="submit" className={buttonVariants({ size: "touch", variant: "outline", className: "col-span-2 sm:col-span-1" })}>
          {t("common.search")}
        </button>
      </form>

      <SectionCard
        title={filtered ? t("inventory.matching") : t("common.products")}
        anchorId="products"
        description={t(result.total === 1 ? "common.productCountOne" : "common.productCount", { count: result.total.toLocaleString("en-IN") })}
        flush
      >
        {result.items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-5 py-12 text-center">
            <span className="grid size-12 place-items-center rounded-2xl bg-teal-soft text-teal-strong">
              <PackageSearch className="size-6" aria-hidden="true" />
            </span>
            <p className="text-base font-semibold text-foreground">{filtered ? t("inventory.noMatch") : t("inventory.none")}</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              {filtered
                ? t("inventory.tryDifferent")
                : canManage
                  ? t("inventory.addHelp")
                  : t("inventory.ownerNotAdded")}
            </p>
            {filtered ? (
              <Link href="/inventory" className={buttonVariants({ variant: "outline", size: "touch" })}>
                {t("common.clearFilters")}
              </Link>
            ) : canManage ? (
              <Link href="/inventory/new" className={buttonVariants({ size: "touch" })}>
                {t("inventory.addFirst")}
              </Link>
            ) : null}
          </div>
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-border md:hidden">
              {result.items.map((product) => (
                <li key={product.id}>
                  <Link href={`/inventory/${product.id}`} className="flex flex-col gap-1 px-5 py-3 hover:bg-muted/50">
                    <span className="flex items-start justify-between gap-3">
                      <span className="font-semibold text-foreground">{product.name}</span>
                      <Money paise={product.retailPaise} withPaise className="shrink-0 font-semibold" />
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {product.sku} · {product.categoryName ?? t("common.noCategory")} · {t("inventory.perUnit", { unit: unitName(t, product.baseUnit, product.baseUnitName).toLowerCase() })}
                    </span>
                    {product.conversions.length > 0 ? <span className="text-xs text-teal-strong">{packSummary(t, product)}</span> : null}
                    {!product.isActive ? <Badge variant="neutral" className="self-start">{t("common.switchedOff")}</Badge> : null}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-5 py-2.5 font-medium">{t("common.product")}</th>
                    <th className="px-3 py-2.5 font-medium">{t("common.category")}</th>
                    <th className="px-3 py-2.5 font-medium">{t("inventory.unitPacks")}</th>
                    <th className="px-3 py-2.5 text-right font-medium">{t("common.retail")}</th>
                    <th className="px-3 py-2.5 text-right font-medium">{t("common.wholesale")}</th>
                    <th className="px-5 py-2.5 font-medium">{t("common.status")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {result.items.map((product) => (
                    <tr key={product.id} className="hover:bg-muted/50">
                      <td className="px-5 py-3">
                        <Link href={`/inventory/${product.id}`} className="font-semibold text-foreground hover:text-teal-strong hover:underline">
                          {product.name}
                        </Link>
                        <p className="text-xs text-muted-foreground">{product.sku}</p>
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">{product.categoryName ?? "—"}</td>
                      <td className="px-3 py-3">
                        <p className="text-foreground">{unitName(t, product.baseUnit, product.baseUnitName)}</p>
                        {product.conversions.length > 0 ? <p className="text-xs text-teal-strong">{packSummary(t, product)}</p> : null}
                      </td>
                      <td className="px-3 py-3 text-right">
                        <Money paise={product.retailPaise} withPaise />
                      </td>
                      <td className="px-3 py-3 text-right">
                        <Money paise={product.wholesalePaise} withPaise />
                      </td>
                      <td className="px-5 py-3">
                        {product.isActive ? <Badge variant="success">{t("common.active")}</Badge> : <Badge variant="neutral">{t("common.switchedOff")}</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
          </>
        )}
      </SectionCard>
    </PageContainer>
  );
}
