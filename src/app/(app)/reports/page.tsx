import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, Download } from "lucide-react";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { RangeFilter } from "@/components/reports/range-filter";
import { getNavItem } from "@/config/navigation";
import { hasPermission } from "@/modules/identity";
import { requireSession } from "@/server/auth";
import { indiaDate } from "@/shared/financial-year";
import type { Permission } from "@/shared/permissions";
import { rangeQuery, resolveRange } from "@/shared/report-range";

const item = getNavItem("reports");

export const metadata: Metadata = { title: "Reports" };

type Props = PageProps<"/reports">;

export default function ReportsPage({ searchParams }: Props) {
  return (
    <ProtectedPage permission="reports.view" title={item.label}>
      <ReportList searchParams={searchParams} />
    </ProtectedPage>
  );
}

const REPORTS: { kind: string; title: string; description: string; ranged: boolean; permission?: Permission }[] = [
  { kind: "sales", title: "Sales (bills)", description: "Every bill: billed, paid at the counter and given on credit.", ranged: true },
  { kind: "collections", title: "Money in and out", description: "Customer payments, old dues, refunds, reversals and supplier payments.", ranged: true },
  { kind: "returns", title: "Returns", description: "Credit notes, refunded or taken off the customer's account.", ranged: true },
  { kind: "expenses", title: "Expenses", description: "Shop expenses by date and category.", ranged: true },
  { kind: "products", title: "Top-selling products", description: "Quantity and billed value per product.", ranged: true },
  { kind: "customer-dues", title: "Customer dues", description: "Balances and overdue amounts today, from the ledger.", ranged: false, permission: "customers.view" },
  { kind: "supplier-dues", title: "Supplier dues", description: "What you owe each supplier today.", ranged: false, permission: "purchases.view" },
  { kind: "stock", title: "Low and out of stock", description: "Products at or below their reorder level.", ranged: false, permission: "inventory.view" },
];

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

async function ReportList({ searchParams }: Pick<Props, "searchParams">) {
  const [query, session] = await Promise.all([searchParams, requireSession()]);
  const today = indiaDate();
  const range = resolveRange({ range: one(query.range), from: one(query.from), to: one(query.to) }, today);
  const allowed = await Promise.all(REPORTS.map((report) => (report.permission ? hasPermission(session, report.permission) : true)));
  const q = rangeQuery(range);
  return (
    <PageContainer>
      <PageIntro description={item.description} />
      <RangeFilter basePath="/reports" range={range} today={today} />
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {REPORTS.filter((_, index) => allowed[index]).map((report) => {
          const suffix = report.ranged ? `?${q}` : "";
          return (
            <li key={report.kind} className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5">
              <div className="flex flex-col gap-1">
                <h2 className="font-semibold text-foreground">{report.title}</h2>
                <p className="text-sm text-muted-foreground">{report.description}</p>
                <p className="text-xs text-muted-foreground">{report.ranged ? range.label : "As of today"}</p>
              </div>
              <div className="mt-auto flex flex-wrap gap-3">
                <Link href={`/reports/${report.kind}${suffix}`} className="inline-flex min-h-10 items-center gap-1 text-sm font-semibold text-teal-strong hover:underline">
                  Open <ArrowUpRight className="size-3.5" aria-hidden="true" />
                </Link>
                <a href={`/reports/${report.kind}/csv${suffix}`} className="inline-flex min-h-10 items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground" download>
                  <Download className="size-3.5" aria-hidden="true" /> CSV
                </a>
              </div>
            </li>
          );
        })}
      </ul>
    </PageContainer>
  );
}
