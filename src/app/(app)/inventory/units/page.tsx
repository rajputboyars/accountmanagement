import type { Metadata } from "next";
import { CatalogTabs } from "@/components/catalog/catalog-tabs";
import { AddUnitForm, UnitActiveToggle } from "@/components/catalog/unit-forms";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { CATALOG_MANAGE, listUnits } from "@/modules/catalog";
import { hasPermission } from "@/modules/identity";
import { requireSession } from "@/server/auth";
import { getT } from "@/server/i18n";
import { unitName, unitShort } from "@/shared/i18n/unit-labels";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.units") };
}

export default function UnitsPage() {
  return (
    <ProtectedPage permission="inventory.view" title="Units">
      <UnitList />
    </ProtectedPage>
  );
}

async function UnitList() {
  const session = await requireSession();
  const t = await getT();
  const [units, canManage] = await Promise.all([listUnits(session, { includeInactive: true }), hasPermission(session, CATALOG_MANAGE)]);

  return (
    <PageContainer>
      <PageIntro description={t("units.intro")} />
      <CatalogTabs current="units" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <SectionCard help="unitsQuantities" title={t("page.units")} anchorId="units" description={t("units.count", { count: units.length })} flush>
          <ul className="flex flex-col divide-y divide-border">
            {units.map((unit) => (
              <li key={unit.code} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="font-semibold text-foreground">
                    {unitName(t, unit.code, unit.name)} <span className="font-normal text-muted-foreground">({unitShort(t, unit.code)})</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {unit.allowDecimal ? t("units.canSplit") : t("units.wholeOnly")} · {t(unit.productCount === 1 ? "units.usedByOne" : "units.usedBy", { count: unit.productCount })}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {unit.isActive ? null : <Badge variant="neutral">{t("common.switchedOff")}</Badge>}
                  {canManage ? <UnitActiveToggle code={unit.code} active={unit.isActive} name={unitName(t, unit.code, unit.name)} /> : null}
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
        {canManage ? (
          <SectionCard title={t("units.addTitle")} anchorId="add-unit" description={t("units.addHelp")}>
            <AddUnitForm />
          </SectionCard>
        ) : null}
      </div>
    </PageContainer>
  );
}
