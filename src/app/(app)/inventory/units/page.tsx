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

export const metadata: Metadata = { title: "Units" };

export default function UnitsPage() {
  return (
    <ProtectedPage permission="inventory.view" title="Units">
      <UnitList />
    </ProtectedPage>
  );
}

async function UnitList() {
  const session = await requireSession();
  const [units, canManage] = await Promise.all([listUnits(session, { includeInactive: true }), hasPermission(session, CATALOG_MANAGE)]);

  return (
    <PageContainer>
      <PageIntro description="The units you count and sell in. How many pieces are in a box is set on each product, because pack sizes differ between brands." />
      <CatalogTabs current="units" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <SectionCard title="Units" description={`${units.length} units`} flush>
          <ul className="flex flex-col divide-y divide-border">
            {units.map((unit) => (
              <li key={unit.code} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="font-semibold text-foreground">
                    {unit.name} <span className="font-normal text-muted-foreground">({unit.code})</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {unit.allowDecimal ? "Can be split, e.g. 2.5" : "Whole numbers only"} · used by {unit.productCount} {unit.productCount === 1 ? "product" : "products"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {unit.isActive ? null : <Badge variant="neutral">Switched off</Badge>}
                  {canManage ? <UnitActiveToggle code={unit.code} active={unit.isActive} name={unit.name} /> : null}
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
        {canManage ? (
          <SectionCard title="Add a unit" description="For example Coil, Roll or Packet.">
            <AddUnitForm />
          </SectionCard>
        ) : null}
      </div>
    </PageContainer>
  );
}
