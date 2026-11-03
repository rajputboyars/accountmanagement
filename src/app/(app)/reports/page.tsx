import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, Download } from "lucide-react";
import { PageContainer, PageIntro } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { RangeFilter } from "@/components/reports/range-filter";
import { hasPermission } from "@/modules/identity";
import { requireSession } from "@/server/auth";
import { getT } from "@/server/i18n";
import { indiaDate } from "@/shared/financial-year";
import type { MessageKey } from "@/shared/i18n";
import { rangeLabel } from "@/shared/i18n/labels";
import type { Permission } from "@/shared/permissions";
import { rangeQuery, resolveRange } from "@/shared/report-range";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("nav.reports.label") };
}

type Props = PageProps<"/reports">;

export default function ReportsPage({ searchParams }: Props) {
  return (
    <ProtectedPage permission="reports.view" title="Reports" guide="reports">
      <ReportList searchParams={searchParams} />
    </ProtectedPage>
  );
}

const REPORTS: { kind: string; ranged: boolean; permission?: Permission }[] = [
  { kind: "sales", ranged: true },
  { kind: "collections", ranged: true },
  { kind: "returns", ranged: true },
  { kind: "expenses", ranged: true },
  { kind: "products", ranged: true },
  { kind: "customer-dues", ranged: false, permission: "customers.view" },
  { kind: "supplier-dues", ranged: false, permission: "purchases.view" },
  { kind: "stock", ranged: false, permission: "inventory.view" },
];

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

async function ReportList({ searchParams }: Pick<Props, "searchParams">) {
  const [query, session, t] = await Promise.all([searchParams, requireSession(), getT()]);
  const today = indiaDate();
  const range = resolveRange({ range: one(query.range), from: one(query.from), to: one(query.to) }, today);
  const allowed = await Promise.all(REPORTS.map((report) => (report.permission ? hasPermission(session, report.permission) : true)));
  const q = rangeQuery(range);
  return (
    <PageContainer>
      <PageIntro description={t("nav.reports.description")} />
      <RangeFilter basePath="/reports" range={range} today={today} />
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {REPORTS.filter((_, index) => allowed[index]).map((report) => {
          const suffix = report.ranged ? `?${q}` : "";
          return (
            <li key={report.kind} className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5">
              <div className="flex flex-col gap-1">
                <h2 className="font-semibold text-foreground">{t(`reports.card.${report.kind}.title` as MessageKey)}</h2>
                <p className="text-sm text-muted-foreground">{t(`reports.card.${report.kind}.description` as MessageKey)}</p>
                <p className="text-xs text-muted-foreground">{report.ranged ? rangeLabel(t, range) : t("reports.asOfToday")}</p>
              </div>
              <div className="mt-auto flex flex-wrap gap-3">
                <Link href={`/reports/${report.kind}${suffix}`} className="inline-flex min-h-10 items-center gap-1 text-sm font-semibold text-teal-strong hover:underline">
                  {t("reports.open")} <ArrowUpRight className="size-3.5" aria-hidden="true" />
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
