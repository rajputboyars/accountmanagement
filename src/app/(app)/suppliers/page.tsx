import type { Metadata } from "next";
import Link from "next/link";
import { Truck } from "lucide-react";
import { SupplierForm } from "@/components/purchases/supplier-forms";
import { Money } from "@/components/nexora/money";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { getNavItem } from "@/config/navigation";
import { hasPermission } from "@/modules/identity";
import { listSuppliers, PURCHASES_EDIT } from "@/modules/purchasing";
import { listPayables } from "@/modules/reporting";
import { requireSession } from "@/server/auth";
import { getLanguage, getT } from "@/server/i18n";
import { billDate } from "@/shared/i18n/labels";

const item = getNavItem("suppliers");

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.suppliers") };
}

export default function SuppliersPage() {
  return (
    <ProtectedPage permission="purchases.view" title={item.label} guide="suppliers">
      <Suppliers />
    </ProtectedPage>
  );
}

async function Suppliers() {
  const session = await requireSession();
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const [suppliers, canEdit, payables] = await Promise.all([listSuppliers(session, { includeInactive: true }), hasPermission(session, PURCHASES_EDIT), listPayables(session)]);
  const overdue = new Map(payables.rows.map((row) => [row.id, row]));
  const totalOwed = suppliers.reduce((sum, supplier) => sum + Math.max(supplier.owedPaise, 0), 0);
  const owing = suppliers.filter((supplier) => supplier.owedPaise > 0).length;

  return (
    <PageContainer>
      <PageIntro description={t("suppliers.intro")} />
      <section className="flex flex-col gap-1 rounded-2xl bg-panel p-5 text-panel-foreground sm:p-6">
        <p className="text-sm text-panel-muted">{t("suppliers.youOwe")}</p>
        <p className="text-3xl font-bold">
          <Money paise={totalOwed} />
        </p>
        <p className="text-sm text-panel-muted">
          {t("suppliers.owingLine", { owing, total: suppliers.length })}<Money paise={payables.totals.overduePaise} />
        </p>
      </section>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <SectionCard title={t("page.suppliers")} description={t("suppliers.inAll", { count: suppliers.length })} flush>
          {suppliers.length === 0 ? (
            <div className="flex flex-col items-center gap-2 border-t border-border px-5 py-12 text-center">
              <Truck className="size-8 text-muted-foreground" aria-hidden="true" />
              <p className="font-semibold text-foreground">{t("suppliers.none")}</p>
              <p className="text-sm text-muted-foreground">{t("suppliers.noneHelp")}</p>
            </div>
          ) : (
            <ul className="flex flex-col divide-y divide-border border-t border-border">
              {suppliers.map((supplier) => (
                <li key={supplier.id}>
                  <Link href={`/suppliers/${supplier.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-muted/50">
                    <span className="min-w-0">
                      <span className="block font-semibold text-foreground">{supplier.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {supplier.phone ?? t("suppliers.noPhone")} · {t("suppliers.paysIn", { days: supplier.paymentTermsDays })}
                        {overdue.get(supplier.id)?.overduePaise ? ` · ${t("suppliers.pastDue")}` : overdue.get(supplier.id)?.nextDue ? ` · ${t("suppliers.nextDue", { date: billDate(overdue.get(supplier.id)!.nextDue!, language) })}` : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      {supplier.owedPaise > 0 ? (
                        <Money paise={supplier.owedPaise} className="font-semibold text-foreground" />
                      ) : supplier.owedPaise < 0 ? (
                        <span className="text-sm text-success">
                          {t("suppliers.owesYou")}<Money paise={-supplier.owedPaise} />
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">{t("suppliers.nothingDue")}</span>
                      )}
                      {!supplier.isActive ? <Badge variant="neutral">{t("common.switchedOff")}</Badge> : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        {canEdit ? (
          <SectionCard title={t("suppliers.add")} className="self-start">
            <SupplierForm />
          </SectionCard>
        ) : null}
      </div>
    </PageContainer>
  );
}
