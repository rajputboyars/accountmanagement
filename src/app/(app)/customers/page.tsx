import type { Metadata } from "next";
import Link from "next/link";
import { Users } from "lucide-react";
import { CustomerForm } from "@/components/customers/customer-forms";
import { Money } from "@/components/nexora/money";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { getNavItem } from "@/config/navigation";
import { listReceivables, searchCustomers } from "@/modules/reporting";
import { requireSession } from "@/server/auth";
import { getT } from "@/server/i18n";
import { HelpHint } from "@/components/nexora/help-hint";

const item = getNavItem("customers");

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("page.customers") };
}

export default function CustomersPage({ searchParams }: PageProps<"/customers">) {
  return (
    <ProtectedPage permission="customers.view" title={item.label} guide="customers">
      <Customers searchParams={searchParams} />
    </ProtectedPage>
  );
}

const TONE = { paid: { label: "customers.paidUp", variant: "success" }, ok: { label: null, variant: "neutral" }, amber: { label: null, variant: "warning" }, red: { label: "customers.overdue", variant: "danger" } } as const;

async function Customers({ searchParams }: { searchParams: PageProps<"/customers">["searchParams"] }) {
  const [session, query, t] = await Promise.all([requireSession(), searchParams, getT()]);
  const q = typeof query.q === "string" ? query.q.slice(0, 60) : "";
  const { rows: allRows, totals, canAdd } = await listReceivables(session);
  const rows = searchCustomers(allRows, q);
  const b = totals.buckets;
  const buckets = [
    [t("customers.bucket.notDue"), b.notDuePaise],
    [t("customers.bucket.1to30"), b.days1to30Paise],
    [t("customers.bucket.31to60"), b.days31to60Paise],
    [t("customers.bucket.61to90"), b.days61to90Paise],
    [t("customers.bucket.over90"), b.over90Paise],
  ] as const;

  return (
    <PageContainer>
      <PageIntro description={t("customers.intro")} />
      <section className="grid gap-4 rounded-2xl bg-panel p-5 text-panel-foreground sm:grid-cols-3 sm:p-6">
        <div>
          <p className="text-sm text-panel-muted">{t("customers.toCollect")}</p>
          <p className="text-3xl font-bold">
            <Money paise={totals.receivablePaise} />
          </p>
        </div>
        <div>
          <p className="text-sm text-panel-muted">{t("customers.overdue30")}</p>
          <p className="text-3xl font-bold">
            <Money paise={totals.overduePaise} />
          </p>
        </div>
        <div>
          <p className="flex items-center gap-1 text-sm text-panel-muted">{t("customers.advances")}<HelpHint topic="advancePayment" /></p>
          <p className="text-3xl font-bold">
            <Money paise={totals.advancesPaise} />
          </p>
        </div>
        <ul className="grid grid-cols-2 gap-2 text-xs sm:col-span-3 sm:grid-cols-5">
          {buckets.map(([label, paise]) => (
            <li key={label} className="rounded-xl bg-panel-2 px-3 py-2">
              <span className="block text-panel-muted">{label}</span>
              <span className="text-sm font-semibold">
                <Money paise={paise} />
              </span>
            </li>
          ))}
        </ul>
      </section>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <SectionCard title={t("page.customers")} description={q ? t("customers.foundFor", { count: rows.length, q }) : t("customers.mostOwedFirst")} flush>
          <form action="/customers" role="search" className="flex gap-2 px-5 pb-3">
            <label className="sr-only" htmlFor="customer-search">
              {t("customers.search")}
            </label>
            <input id="customer-search" type="search" name="q" defaultValue={q} placeholder={t("customers.searchPlaceholder")} className="h-11 min-w-0 flex-1 rounded-xl border border-input bg-background px-3 text-sm" />
            <button type="submit" className={buttonVariants({ variant: "outline", size: "touch" })}>
              {t("common.search")}
            </button>
          </form>
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 border-t border-border px-5 py-12 text-center">
              <Users className="size-8 text-muted-foreground" aria-hidden="true" />
              <p className="font-semibold text-foreground">{t(q ? "customers.noMatch" : "customers.none")}</p>
              <p className="max-w-sm text-sm text-muted-foreground">{t(q ? "customers.noMatchHelp" : "customers.noneHelp")}</p>
              {q ? (
                <Link href="/customers" className={buttonVariants({ variant: "outline", size: "touch" })}>
                  {t("customers.showAll")}
                </Link>
              ) : canAdd ? (
                <a href="#section-add-a-customer" className={buttonVariants({ variant: "outline", size: "touch" })}>
                  {t("customers.addFirst")}
                </a>
              ) : null}
            </div>
          ) : (
            <ul className="flex flex-col divide-y divide-border border-t border-border">
              {rows.map((row) => (
                <li key={row.id}>
                  <Link href={`/customers/${row.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-muted/50">
                    <span className="min-w-0">
                      <span className="block font-semibold text-foreground">{row.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {t(row.type === "wholesale" ? "common.wholesale" : "common.retail")}
                        {row.phone ? ` · ${row.phone}` : ""}
                        {row.oldestDueDays !== null ? ` · ${t("customers.oldestDue", { days: row.oldestDueDays })}` : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      {row.balancePaise < 0 ? (
                        <span className="text-sm text-success">
                          {t("customers.advance")}<Money paise={-row.balancePaise} />
                        </span>
                      ) : (
                        <Money paise={row.balancePaise} className="font-semibold text-foreground" />
                      )}
                      {TONE[row.tone].label ? <Badge variant={TONE[row.tone].variant}>{t(TONE[row.tone].label!)}</Badge> : null}
                      {!row.isActive ? <Badge variant="neutral">{t("common.switchedOff")}</Badge> : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        {canAdd ? (
          <SectionCard title={t("customers.add")} anchorId="section-add-a-customer" className="self-start">
            <CustomerForm />
          </SectionCard>
        ) : null}
      </div>
    </PageContainer>
  );
}
