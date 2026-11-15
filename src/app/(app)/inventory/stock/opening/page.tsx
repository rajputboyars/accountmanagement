import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { OpeningStockForm } from "@/components/inventory/opening-stock-form";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { selectClass } from "@/components/catalog/form-bits";
import { buttonVariants } from "@/components/ui/button";
import { listGodowns, listOpeningCandidates } from "@/modules/inventory";
import { requireSession } from "@/server/auth";
import { getT } from "@/server/i18n";
import { unitName, unitShort } from "@/shared/i18n/unit-labels";
import { indiaDate } from "@/shared/financial-year";
import { HelpHint } from "@/components/nexora/help-hint";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.openingStock") };
}

export default function OpeningStockPage({ searchParams }: PageProps<"/inventory/stock/opening">) {
  return (
    <ProtectedPage permission="stock.opening" title="Opening stock">
      <OpeningStock searchParams={searchParams} />
    </ProtectedPage>
  );
}

async function OpeningStock({ searchParams }: { searchParams: PageProps<"/inventory/stock/opening">["searchParams"] }) {
  const session = await requireSession();
  const t = await getT();
  const params = await searchParams;
  const wanted = Array.isArray(params.godown) ? params.godown[0] : params.godown;
  // With several godowns, each is opened on its own; otherwise it is always the Main Store and nothing is asked.
  const places = await listGodowns(session);
  const manyGodowns = places.length > 1;
  const godown = manyGodowns ? (places.find((place) => place.id === wanted) ?? places.find((place) => place.isDefault) ?? places[0]) : undefined;
  const { products, canEnterCost } = await listOpeningCandidates(session, godown ? { godownId: godown.id } : {});
  return (
    <PageContainer className="max-w-5xl">
      <Link href="/inventory/stock" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("page.stock")}
      </Link>
      <section className="flex flex-col gap-2 rounded-2xl bg-panel p-5 text-panel-foreground sm:p-6">
        <div className="flex items-center gap-1.5"><h2 className="text-xl font-bold">{t("stock.enterOpening")}</h2><HelpHint topic="openingStock" /></div>
        <p className="max-w-2xl text-sm text-panel-muted">
          {t("stock.openingHelp")}
        </p>
        <p className="text-sm text-panel-muted">
          {t(products.length === 1 ? "stock.noneEnteredOne" : "stock.noneEntered", { count: products.length.toLocaleString("en-IN") })}
        </p>
      </section>
      {godown ? (
        <form action="/inventory/stock/opening" className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-48 flex-col gap-1.5 text-sm font-medium text-foreground">
            {t("godown.openingFor")}
            <select name="godown" defaultValue={godown.id} className={selectClass}>
              {places.map((place) => (
                <option key={place.id} value={place.id}>
                  {place.isDefault && place.name === "Main Store" ? t("godown.mainStore") : place.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={buttonVariants({ variant: "outline", size: "touch" })}>
            {t("godown.show")}
          </button>
        </form>
      ) : null}
      <SectionCard help="stockValuation" title={t("stock.productsQuantities")} anchorId="lines" description={t("stock.savedTogether")}>
        <OpeningStockForm godownId={godown?.id} key={godown?.id ?? "main"} products={products.map((product) => ({ ...product, baseUnitLabel: unitShort(t, product.baseUnit), units: product.units.map((unit) => ({ code: unit.code, factor: unit.factor, shortLabel: unitShort(t, unit.code), label: unit.isBase ? `${unitName(t, unit.code, unit.name)} (${unitShort(t, unit.code)})` : t("unit.packOfBase", { unit: unitName(t, unit.code, unit.name), qty: unit.factor, base: unitShort(t, product.baseUnit) }) })) }))} canEnterCost={canEnterCost} today={indiaDate()} />
      </SectionCard>
    </PageContainer>
  );
}
