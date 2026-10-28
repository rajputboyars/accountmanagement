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

const item = getNavItem("customers");

export const metadata: Metadata = { title: "Customers" };

export default function CustomersPage({ searchParams }: PageProps<"/customers">) {
  return (
    <ProtectedPage permission="customers.view" title={item.label}>
      <Customers searchParams={searchParams} />
    </ProtectedPage>
  );
}

const TONE = { paid: { label: "Paid up", variant: "success" }, ok: { label: "", variant: "neutral" }, amber: { label: "", variant: "warning" }, red: { label: "Overdue", variant: "danger" } } as const;

async function Customers({ searchParams }: { searchParams: PageProps<"/customers">["searchParams"] }) {
  const [session, query] = await Promise.all([requireSession(), searchParams]);
  const q = typeof query.q === "string" ? query.q.slice(0, 60) : "";
  const { rows: allRows, totals, canAdd } = await listReceivables(session);
  const rows = searchCustomers(allRows, q);
  const b = totals.buckets;
  const buckets = [
    ["Not yet due", b.notDuePaise],
    ["1–30 days late", b.days1to30Paise],
    ["31–60", b.days31to60Paise],
    ["61–90", b.days61to90Paise],
    ["90+", b.over90Paise],
  ] as const;

  return (
    <PageContainer>
      <PageIntro description="What each customer owes, worked out from every bill, payment and credit note. A bill is overdue after 30 days." />
      <section className="grid gap-4 rounded-2xl bg-panel p-5 text-panel-foreground sm:grid-cols-3 sm:p-6">
        <div>
          <p className="text-sm text-panel-muted">To collect</p>
          <p className="text-3xl font-bold">
            <Money paise={totals.receivablePaise} />
          </p>
        </div>
        <div>
          <p className="text-sm text-panel-muted">Overdue (30+ days)</p>
          <p className="text-3xl font-bold">
            <Money paise={totals.overduePaise} />
          </p>
        </div>
        <div>
          <p className="text-sm text-panel-muted">Advances held</p>
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
        <SectionCard title="Customers" description={q ? `${rows.length} found for "${q}"` : "Most owed first"} flush>
          <form action="/customers" role="search" className="flex gap-2 px-5 pb-3">
            <label className="sr-only" htmlFor="customer-search">
              Search customers
            </label>
            <input id="customer-search" type="search" name="q" defaultValue={q} placeholder="Name or mobile number" className="h-11 min-w-0 flex-1 rounded-xl border border-input bg-background px-3 text-sm" />
            <button type="submit" className={buttonVariants({ variant: "outline", size: "touch" })}>
              Search
            </button>
          </form>
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 border-t border-border px-5 py-12 text-center">
              <Users className="size-8 text-muted-foreground" aria-hidden="true" />
              <p className="font-semibold text-foreground">{q ? "No customer matches" : "No customers yet"}</p>
              <p className="max-w-sm text-sm text-muted-foreground">{q ? "Check the spelling, or search by a few digits of the mobile number." : "Add the people who buy on udhaar (credit) or come back often, so their dues are tracked. Walk-in cash sales don't need a customer."}</p>
              {q ? (
                <Link href="/customers" className={buttonVariants({ variant: "outline", size: "touch" })}>
                  Show all customers
                </Link>
              ) : canAdd ? (
                <a href="#section-add-a-customer" className={buttonVariants({ variant: "outline", size: "touch" })}>
                  Add your first customer
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
                        {row.type === "wholesale" ? "Wholesale" : "Retail"}
                        {row.phone ? ` · ${row.phone}` : ""}
                        {row.oldestDueDays !== null ? ` · oldest due ${row.oldestDueDays} days` : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      {row.balancePaise < 0 ? (
                        <span className="text-sm text-success">
                          Advance <Money paise={-row.balancePaise} />
                        </span>
                      ) : (
                        <Money paise={row.balancePaise} className="font-semibold text-foreground" />
                      )}
                      {TONE[row.tone].label ? <Badge variant={TONE[row.tone].variant}>{TONE[row.tone].label}</Badge> : null}
                      {!row.isActive ? <Badge variant="neutral">Switched off</Badge> : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        {canAdd ? (
          <SectionCard title="Add a customer" className="self-start">
            <CustomerForm />
          </SectionCard>
        ) : null}
      </div>
    </PageContainer>
  );
}
