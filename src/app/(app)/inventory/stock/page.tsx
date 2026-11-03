import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, ClipboardList, PackageSearch, Search } from "lucide-react";
import { CatalogTabs } from "@/components/catalog/catalog-tabs";
import { selectClass } from "@/components/catalog/form-bits";
import { STOCK_STATUS_LABEL, StockStatusBadge } from "@/components/inventory/stock-status-badge";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { listCategories } from "@/modules/catalog";
import { hasPermission } from "@/modules/identity";
import { listAdjustments, listStock, STOCK_OPENING, STOCK_STATUS_FILTERS, type StockStatus, type StockStatusFilter } from "@/modules/inventory";
import { requireSession } from "@/server/auth";
import { getT } from "@/server/i18n";
import type { MessageKey } from "@/shared/i18n";
import { unitShort } from "@/shared/i18n/unit-labels";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.stock") };
}

type Search = PageProps<"/inventory/stock">["searchParams"];

export default function StockPage({ searchParams }: PageProps<"/inventory/stock">) {
  return (
    <ProtectedPage permission="inventory.view" title="Stock" guide="inventory">
      <StockList searchParams={searchParams} />
    </ProtectedPage>
  );
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";
const ADJUSTMENT_KIND: Record<string, MessageKey> = { return_in: "stock.kind.returnIn", damage: "stock.kind.damage", count: "stock.kind.count" };
const SUMMARY: StockStatus[] = ["healthy", "low", "reorder", "out", "uncounted", "needs_check"];

async function StockList({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const session = await requireSession();
  const t = await getT();
  const q = one(params.q).trim();
  const categoryId = one(params.category);
  const statusParam = one(params.status);
  const status: StockStatusFilter = (STOCK_STATUS_FILTERS as readonly string[]).includes(statusParam) ? (statusParam as StockStatusFilter) : "all";
  const page = Math.max(1, Number.parseInt(one(params.page), 10) || 1);
  const [result, categories, canOpen, adjustments] = await Promise.all([
    listStock(session, { q, categoryId: categoryId || undefined, status, page }),
    listCategories(session),
    hasPermission(session, STOCK_OPENING),
    listAdjustments(session, 8),
  ]);
  const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
  const href = (changes: Record<string, string | number | null>) => {
    const next = new URLSearchParams();
    const merged = { q, category: categoryId, status: status === "all" ? "" : status, page: "", ...changes };
    for (const [name, value] of Object.entries(merged)) if (value) next.set(name, String(value));
    const query = next.toString();
    return query ? `/inventory/stock?${query}` : "/inventory/stock";
  };
  const filtered = q !== "" || categoryId !== "" || status !== "all";

  return (
    <PageContainer>
      <PageIntro
        description={t("stock.intro")}
        actions={
          canOpen && result.counts.uncounted > 0 ? (
            <Link href="/inventory/stock/opening" className={buttonVariants({ size: "touch" })}>
              <ClipboardList aria-hidden="true" />
              {t("stock.enterOpening")}
            </Link>
          ) : null
        }
      />
      <CatalogTabs current="stock" />

      <section aria-label={t("stock.summary")} className="rounded-2xl bg-panel p-5 text-panel-foreground sm:p-6">
        <h2 className="text-base font-semibold">{t("stock.glance")}</h2>
        <p className="text-sm text-panel-muted">{t("stock.glanceHelp")}</p>
        <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {SUMMARY.map((key) => (
            <li key={key}>
              <Link
                href={href({ status: status === key ? "" : key })}
                aria-current={status === key ? "true" : undefined}
                className={`flex flex-col rounded-xl px-3 py-2.5 transition-colors ${status === key ? "bg-panel-foreground/20" : "bg-panel-2 hover:bg-panel-foreground/10"}`}
              >
                <span className="text-2xl font-bold tabular-nums">{result.counts[key].toLocaleString("en-IN")}</span>
                <span className="text-xs text-panel-muted">{t(STOCK_STATUS_LABEL[key])}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.8fr)_minmax(0,1fr)]">
        <SectionCard title={filtered ? t("inventory.matching") : t("common.products")} anchorId="products" description={t(result.total === 1 ? "common.productCountOne" : "common.productCount", { count: result.total.toLocaleString("en-IN") })} flush>
          <form role="search" action="/inventory/stock" className="grid grid-cols-2 gap-2 px-5 pb-3 sm:grid-cols-[minmax(0,1fr)_11rem_10rem_auto]">
            <label className="relative col-span-2 sm:col-span-1">
              <span className="sr-only">{t("inventory.search")}</span>
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input name="q" defaultValue={q} placeholder={t("stock.searchShort")} className="h-11 pl-9" />
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
              <span className="sr-only">{t("stock.statusLabel")}</span>
              <select name="status" defaultValue={status} className={selectClass}>
                <option value="all">{t("stock.anyStatus")}</option>
                {SUMMARY.map((key) => (
                  <option key={key} value={key}>
                    {t(STOCK_STATUS_LABEL[key])}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className={buttonVariants({ size: "touch", variant: "outline", className: "col-span-2 sm:col-span-1" })}>
              {t("common.search")}
            </button>
          </form>

          {result.items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 border-t border-border px-5 py-12 text-center">
              <span className="grid size-12 place-items-center rounded-2xl bg-teal-soft text-teal-strong">
                <PackageSearch className="size-6" aria-hidden="true" />
              </span>
              <p className="font-semibold text-foreground">{filtered ? t("inventory.noMatch") : t("inventory.none")}</p>
              <p className="max-w-sm text-sm text-muted-foreground">{filtered ? t("stock.tryAnother") : t("stock.addFirst")}</p>
              <Link href={filtered ? "/inventory/stock" : "/inventory/new"} className={buttonVariants({ variant: "outline", size: "touch" })}>
                {filtered ? t("common.clearFilters") : t("stock.addProduct")}
              </Link>
            </div>
          ) : (
            <ul className="flex flex-col divide-y divide-border border-t border-border">
              {result.items.map((row) => (
                <li key={row.productId}>
                  <Link href={`/inventory/stock/${row.productId}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-muted/50">
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-foreground">{row.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {row.sku} · {row.categoryName ?? t("common.noCategory")} · {t("stock.reorderAt", { qty: row.reorderLevel, unit: unitShort(t, row.baseUnit) })}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <span className="text-base font-semibold tabular-nums text-foreground">{row.qty === null ? "—" : `${row.qty} ${unitShort(t, row.baseUnit)}`}</span>
                      <StockStatusBadge status={row.status} />
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
                  <Link href={href({ page: result.page - 1 })} className={buttonVariants({ variant: "outline", size: "sm" })}>
                    <ChevronLeft aria-hidden="true" />
                    {t("common.previous")}
                  </Link>
                ) : null}
                {result.page < lastPage ? (
                  <Link href={href({ page: result.page + 1 })} className={buttonVariants({ variant: "outline", size: "sm" })}>
                    {t("common.next")}
                    <ChevronRight aria-hidden="true" />
                  </Link>
                ) : null}
              </div>
            </nav>
          ) : null}
        </SectionCard>

        <SectionCard help="stockAdjustment" title={t("stock.adjustments")} anchorId="adjustments" description={t("stock.adjustmentsHelp")}>
          {adjustments.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("stock.noAdjustments")}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border text-sm">
              {adjustments.map((adjustment) => (
                <li key={adjustment.id} className="flex flex-col gap-0.5 py-2.5 first:pt-0">
                  <span className="flex justify-between gap-2">
                    <span className="font-semibold text-foreground">{adjustment.number}</span>
                    <span className="tabular-nums text-foreground">{adjustment.qtyChange}</span>
                  </span>
                  <span className="text-muted-foreground">
                    {t(ADJUSTMENT_KIND[adjustment.kind] ?? "stock.kind.count")}: {adjustment.reason}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </PageContainer>
  );
}
