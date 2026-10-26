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

export const metadata: Metadata = { title: "Product stock" };

type Props = PageProps<"/inventory/stock/[productId]">;

export default function ProductStockPage({ params, searchParams }: Props) {
  return (
    <ProtectedPage permission="inventory.view" title="Stock">
      <ProductStock params={params} searchParams={searchParams} />
    </ProtectedPage>
  );
}

const KIND_LABEL: Record<string, string> = {
  opening: "Opening stock",
  sale: "Sale",
  sale_cancel: "Sale cancelled",
  return_in: "Customer return",
  purchase: "Purchase received",
  return_out: "Returned to supplier",
  damage: "Damaged",
  count: "Count fix",
};

const dateText = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));

async function ProductStock({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const [{ productId }, query] = await Promise.all([params, searchParams]);
  const before = Number.parseInt(String(query.before ?? ""), 10);
  const session = await requireSession();
  const stock = await getProductStock(session, productId, { before: Number.isSafeInteger(before) && before > 0 ? before : undefined }).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });

  if (!stock) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title="Product not found" description="It may have been typed wrongly, or it belongs to a different shop.">
          <Link href="/inventory/stock" className="text-sm font-semibold text-teal-strong hover:underline">
            Back to stock
          </Link>
        </SectionCard>
      </PageContainer>
    );
  }

  const units = [{ code: stock.baseUnit, label: `${stock.baseUnitName} (${stock.baseUnit})` }, ...stock.saleUnits.map((unit) => ({ code: unit.code, label: `${unit.name} of ${unit.factor}` }))];
  const showCost = stock.movements.some((movement) => movement.unitCostPaise !== null);

  return (
    <PageContainer className="max-w-6xl">
      <Link href="/inventory/stock" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Stock
      </Link>

      <section className="flex flex-col gap-4 rounded-2xl bg-panel p-5 text-panel-foreground sm:flex-row sm:items-end sm:justify-between sm:p-6">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-xs font-semibold tracking-wide text-panel-muted uppercase">{stock.sku}</p>
          <h2 className="text-xl font-bold sm:text-2xl">{stock.name}</h2>
          <p className="text-sm text-panel-muted">
            {stock.categoryName ?? "No category"} · reorder at {stock.reorderLevel} {stock.baseUnit}
            {stock.saleUnits.length > 0 ? ` · ${stock.saleUnits.map((unit) => `1 ${unit.name.toLowerCase()} = ${unit.factor} ${stock.baseUnit}`).join(", ")}` : ""}
          </p>
          <div className="mt-1">
            <StockStatusBadge status={stock.status} />
          </div>
        </div>
        <div className="sm:text-right">
          <p className="text-sm text-panel-muted">On hand</p>
          <p className="text-3xl font-bold tabular-nums">{stock.qty === null ? "Not counted" : `${stock.qty} ${stock.baseUnit}`}</p>
        </div>
      </section>

      {stock.problem ? (
        <div role="alert" className="flex flex-col gap-3 rounded-2xl border border-amber/40 bg-amber-soft p-4 text-sm text-amber-ink">
          <p className="flex gap-2">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {stock.problem}
          </p>
          {stock.permissions.canAdjust && stock.status === "needs_check" && !stock.problem.startsWith("Stock is below zero") ? <RebuildCacheButton productId={stock.productId} /> : null}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <SectionCard title="Stock history" description="Every entry that changed this product's stock, newest first. Entries are never edited or deleted." flush>
          {stock.movements.length === 0 ? (
            <p className="px-5 pb-3 text-sm text-muted-foreground">No stock entries yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-5 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">What</th>
                    <th className="px-3 py-2 text-right font-medium">Change</th>
                    {showCost ? <th className="px-3 py-2 text-right font-medium">Cost / {stock.baseUnit}</th> : null}
                    <th className="px-5 py-2 font-medium">By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {stock.movements.map((movement) => (
                    <tr key={movement.id}>
                      <td className="px-5 py-2.5 whitespace-nowrap text-muted-foreground">{dateText(movement.date)}</td>
                      <td className="px-3 py-2.5">
                        <p className="font-medium text-foreground">{KIND_LABEL[movement.kind] ?? movement.kind}</p>
                        {movement.reason ? <p className="text-xs text-muted-foreground">{movement.reason}</p> : null}
                      </td>
                      <td className={`px-3 py-2.5 text-right font-semibold whitespace-nowrap tabular-nums ${movement.qty.startsWith("-") ? "text-danger" : "text-success"}`}>
                        {movement.qty.startsWith("-") ? movement.qty : `+${movement.qty}`} {stock.baseUnit}
                      </td>
                      {showCost ? <td className="px-3 py-2.5 text-right">{movement.unitCostPaise === null ? "—" : <Money paise={movement.unitCostPaise} withPaise />}</td> : null}
                      <td className="px-5 py-2.5 text-muted-foreground">{movement.createdByName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {stock.moreBefore || before ? (
            <nav aria-label="History pages" className="flex justify-between gap-2 border-t border-border px-5 pt-3">
              {before ? (
                <Link href={`/inventory/stock/${stock.productId}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Newest
                </Link>
              ) : (
                <span />
              )}
              {stock.moreBefore ? (
                <Link href={`/inventory/stock/${stock.productId}?before=${stock.moreBefore}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Older entries
                </Link>
              ) : null}
            </nav>
          ) : null}
        </SectionCard>

        <SectionCard title={stock.hasMovements ? "Record an adjustment" : "Opening stock"} className="self-start">
          {!stock.hasMovements ? (
            <div className="flex flex-col gap-3 text-sm text-muted-foreground">
              <p>Nothing has been counted for this product yet, so its stock is unknown (not zero).</p>
              {stock.permissions.canOpen ? (
                <Link href="/inventory/stock/opening" className={buttonVariants({ size: "touch", className: "self-start" })}>
                  <ClipboardList aria-hidden="true" />
                  Enter opening stock
                </Link>
              ) : (
                <p>Ask the owner to enter its opening stock.</p>
              )}
            </div>
          ) : stock.permissions.canAdjust ? (
            <AdjustmentForm productId={stock.productId} units={units} baseUnit={stock.baseUnit} />
          ) : (
            <p className="text-sm text-muted-foreground">You can see stock but not change it. Ask the owner, a manager or inventory staff.</p>
          )}
        </SectionCard>
      </div>
    </PageContainer>
  );
}
