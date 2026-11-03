import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ClipboardList, TriangleAlert } from "lucide-react";
import { AdjustmentForm, RebuildCacheButton } from "@/components/inventory/adjustment-form";
import { StockStatusBadge } from "@/components/inventory/stock-status-badge";
import { Money } from "@/components/nexora/money";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { buttonVariants } from "@/components/ui/button";
import { getProductStock } from "@/modules/inventory";
import { requireSession } from "@/server/auth";
import { NotFoundError } from "@/server/errors";
import { getLanguage, getT } from "@/server/i18n";
import { translateServerMessage, type MessageKey } from "@/shared/i18n";
import { billDate, movementReason, systemName } from "@/shared/i18n/labels";
import { packLabel, unitName, unitShort } from "@/shared/i18n/unit-labels";
import { HelpHint } from "@/components/nexora/help-hint";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.productStock") };
}

type Props = PageProps<"/inventory/stock/[productId]">;

export default function ProductStockPage({ params, searchParams }: Props) {
  return (
    <ProtectedPage permission="inventory.view" title="Stock">
      <ProductStock params={params} searchParams={searchParams} />
    </ProtectedPage>
  );
}

const KIND_LABEL: Record<string, MessageKey> = {
  opening: "stock.kind.opening",
  sale: "stock.kind.sale",
  sale_cancel: "stock.kind.saleCancel",
  return_in: "stock.kind.returnIn",
  purchase: "stock.kind.purchase",
  return_out: "stock.kind.returnOut",
  damage: "stock.kind.damage",
  count: "stock.kind.count",
};

async function ProductStock({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const [{ productId }, query] = await Promise.all([params, searchParams]);
  const before = Number.parseInt(String(query.before ?? ""), 10);
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const dateText = (value: string) => billDate(value, language);
  const stock = await getProductStock(session, productId, { before: Number.isSafeInteger(before) && before > 0 ? before : undefined }).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });

  if (!stock) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title={t("inventory.notFound")} anchorId="not-found" description={t("inventory.notFoundHelp")}>
          <Link href="/inventory/stock" className="text-sm font-semibold text-teal-strong hover:underline">
            {t("stock.backTo")}
          </Link>
        </SectionCard>
      </PageContainer>
    );
  }

  const base = unitShort(t, stock.baseUnit);
  const units = [{ code: stock.baseUnit, label: `${unitName(t, stock.baseUnit, stock.baseUnitName)} (${base})` }, ...stock.saleUnits.map((unit) => ({ code: unit.code, label: packLabel(t, unit.code, unit.name, unit.factor) }))];
  const showCost = stock.movements.some((movement) => movement.unitCostPaise !== null);

  return (
    <PageContainer className="max-w-6xl">
      <Link href="/inventory/stock" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("page.stock")}
      </Link>

      <section className="flex flex-col gap-4 rounded-2xl bg-panel p-5 text-panel-foreground sm:flex-row sm:items-end sm:justify-between sm:p-6">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-xs font-semibold tracking-wide text-panel-muted uppercase">{stock.sku}</p>
          <h2 className="text-xl font-bold sm:text-2xl">{stock.name}</h2>
          <p className="text-sm text-panel-muted">
            {stock.categoryName ?? t("common.noCategory")} · {t("stock.reorderAt", { qty: stock.reorderLevel, unit: base })}
            {stock.saleUnits.length > 0 ? ` · ${stock.saleUnits.map((unit) => t("inventory.packLine", { unit: unitName(t, unit.code, unit.name).toLowerCase(), factor: unit.factor, base })).join(", ")}` : ""}
          </p>
          <div className="mt-1">
            <StockStatusBadge status={stock.status} />
          </div>
        </div>
        <div className="sm:text-right">
          <p className="flex items-center gap-1 text-sm text-panel-muted sm:justify-end">{t("stock.available")}<HelpHint topic="availableStock" /></p>
          <p data-guide="stock-available" className="text-3xl font-bold tabular-nums">{stock.qty === null ? t("stock.notCounted") : `${stock.qty} ${base}`}</p>
        </div>
      </section>

      {stock.problem ? (
        <div role="alert" className="flex flex-col gap-3 rounded-2xl border border-amber/40 bg-amber-soft p-4 text-sm text-amber-ink">
          <p className="flex gap-2">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {translateServerMessage(stock.problem, language)}
          </p>
          {stock.permissions.canAdjust && stock.status === "needs_check" && !stock.problem.startsWith("Stock is below zero") ? <RebuildCacheButton productId={stock.productId} /> : null}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <SectionCard title={t("stock.history")} anchorId="history" description={t("stock.historyHelp")} flush>
          {stock.movements.length === 0 ? (
            <p className="px-5 pb-3 text-sm text-muted-foreground">{t("stock.noEntries")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="stack-table stack-table-flush w-full min-w-[34rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-5 py-2 font-medium">{t("common.date")}</th>
                    <th className="px-3 py-2 font-medium">{t("stock.what")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("stock.change")}</th>
                    {showCost ? <th className="px-3 py-2 text-right font-medium">{t("stock.costPer", { unit: base })}</th> : null}
                    <th className="px-5 py-2 font-medium">{t("stock.by")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {stock.movements.map((movement) => (
                    <tr key={movement.id}>
                      <td data-label={t("common.date")} className="px-5 py-2.5 whitespace-nowrap text-muted-foreground">{dateText(movement.date)}</td>
                      <td data-title className="px-3 py-2.5">
                        <p className="font-medium text-foreground">{KIND_LABEL[movement.kind] ? t(KIND_LABEL[movement.kind]!) : movement.kind}</p>
                        {movement.reason ? <p className="text-xs text-muted-foreground">{movementReason(movement.reason, language)}</p> : null}
                      </td>
                      <td data-key data-label={t("stock.change")} className={`px-3 py-2.5 text-right font-semibold whitespace-nowrap tabular-nums ${movement.qty.startsWith("-") ? "text-danger" : "text-success"}`}>
                        {movement.qty.startsWith("-") ? movement.qty : `+${movement.qty}`} {base}
                      </td>
                      {showCost ? <td data-label={t("stock.costPer", { unit: base })} className="px-3 py-2.5 text-right">{movement.unitCostPaise === null ? "—" : <Money paise={movement.unitCostPaise} withPaise />}</td> : null}
                      <td data-label={t("stock.by")} className="px-5 py-2.5 text-muted-foreground">{systemName(movement.createdByName, language)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {stock.moreBefore || before ? (
            <nav aria-label={t("stock.historyPages")} className="flex justify-between gap-2 border-t border-border px-5 pt-3">
              {before ? (
                <Link href={`/inventory/stock/${stock.productId}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  {t("stock.newest")}
                </Link>
              ) : (
                <span />
              )}
              {stock.moreBefore ? (
                <Link href={`/inventory/stock/${stock.productId}?before=${stock.moreBefore}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  {t("stock.olderEntries")}
                </Link>
              ) : null}
            </nav>
          ) : null}
        </SectionCard>

        <SectionCard help={stock.hasMovements ? "stockAdjustment" : "openingStock"} title={stock.hasMovements ? t("stock.recordAdjustment") : t("page.openingStock")} anchorId="adjust" className="self-start">
          {!stock.hasMovements ? (
            <div className="flex flex-col gap-3 text-sm text-muted-foreground">
              <p>{t("stock.unknown")}</p>
              {stock.permissions.canOpen ? (
                <Link href="/inventory/stock/opening" className={buttonVariants({ size: "touch", className: "self-start" })}>
                  <ClipboardList aria-hidden="true" />
                  {t("stock.enterOpening")}
                </Link>
              ) : (
                <p>{t("stock.askOwnerOpening")}</p>
              )}
            </div>
          ) : stock.permissions.canAdjust ? (
            <AdjustmentForm productId={stock.productId} units={units} baseUnit={stock.baseUnit} baseUnitLabel={base} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("stock.cantChange")}</p>
          )}
        </SectionCard>
      </div>
    </PageContainer>
  );
}
