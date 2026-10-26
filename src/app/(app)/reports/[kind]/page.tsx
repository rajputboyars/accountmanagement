import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Download } from "lucide-react";
import { Money } from "@/components/nexora/money";
import { PageContainer } from "@/components/nexora/page-container";
import { ProtectedPage } from "@/components/nexora/protected-page";
import { SectionCard } from "@/components/nexora/section-card";
import { RangeFilter } from "@/components/reports/range-filter";
import { buttonVariants } from "@/components/ui/button";
import { getReport, type ReportColumn } from "@/modules/reporting";
import { requireSession } from "@/server/auth";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { rangeQuery } from "@/shared/report-range";

export const metadata: Metadata = { title: "Report" };

type Props = PageProps<"/reports/[kind]">;

export default function ReportPage({ params, searchParams }: Props) {
  return (
    <ProtectedPage permission="reports.view" title="this report">
      <ReportView params={params} searchParams={searchParams} />
    </ProtectedPage>
  );
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const dateText = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));

function Cell({ column, value }: { column: ReportColumn; value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === "") return <span className="text-muted-foreground">—</span>;
  if (column.type === "money") return <Money paise={Number(value)} withPaise />;
  if (column.type === "date") return <span className="whitespace-nowrap">{dateText(String(value))}</span>;
  if (column.type === "qty") return <span className="tabular-nums">{Number(value).toLocaleString("en-IN", { maximumFractionDigits: 3 })}</span>;
  return <>{value}</>;
}

const right = (column: ReportColumn) => column.type === "money" || column.type === "qty";

async function ReportView({ params, searchParams }: Props) {
  const [{ kind }, query, session] = await Promise.all([params, searchParams, requireSession()]);
  const report = await getReport(session, kind, { range: one(query.range), from: one(query.from), to: one(query.to) }).catch((error: unknown) => {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) return error;
    throw error;
  });
  if (!("columns" in report)) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title={report instanceof ForbiddenError ? "You can't open this report" : "Report not found"} description={report instanceof ForbiddenError ? "Ask the owner for access." : undefined}>
          <Link href="/reports" className="text-sm font-semibold text-teal-strong hover:underline">
            Back to reports
          </Link>
        </SectionCard>
      </PageContainer>
    );
  }
  const suffix = report.range ? `?${rangeQuery(report.range)}` : "";
  const hasTotals = Object.keys(report.totals).length > 0;
  return (
    <PageContainer>
      <Link href={`/reports${suffix}`} className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Reports
      </Link>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{report.title}</h1>
          <p className="text-sm text-muted-foreground">{report.description}</p>
        </div>
        <a href={`/reports/${report.kind}/csv${suffix}`} download className={buttonVariants({ variant: "outline", size: "touch" })}>
          <Download aria-hidden="true" />
          Export CSV
        </a>
      </div>
      {report.range ? <RangeFilter basePath={`/reports/${report.kind}`} range={report.range} today={indiaDate()} /> : null}
      <SectionCard title={report.range ? report.range.label : "As of today"} description={`${report.rows.length} ${report.rows.length === 1 ? "row" : "rows"}${report.truncated ? " shown. There are more: choose a shorter range, or export CSV (up to 5,000 rows)." : ""}`} flush>
        {report.rows.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-muted-foreground">Nothing to show for this period.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  {report.columns.map((column, index) => (
                    <th key={column.key} scope="col" className={`py-2 font-medium ${index === 0 ? "pl-5" : "pl-3"} ${index === report.columns.length - 1 ? "pr-5" : "pr-3"} ${right(column) ? "text-right" : ""}`}>
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {report.rows.map((row) => (
                  <tr key={row.id} className="hover:bg-muted/40">
                    {report.columns.map((column, index) => (
                      <td key={column.key} className={`py-2 ${index === 0 ? "pl-5" : "pl-3"} ${index === report.columns.length - 1 ? "pr-5" : "pr-3"} ${right(column) ? "text-right" : ""}`}>
                        {index === 0 && row.href ? (
                          <Link href={row.href} className="font-medium text-teal-strong hover:underline">
                            <Cell column={column} value={row.cells[column.key]} />
                          </Link>
                        ) : (
                          <Cell column={column} value={row.cells[column.key]} />
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {hasTotals ? (
                <tfoot>
                  <tr className="border-t-2 border-border font-semibold">
                    {report.columns.map((column, index) => (
                      <td key={column.key} className={`py-2.5 ${index === 0 ? "pl-5" : "pl-3"} ${index === report.columns.length - 1 ? "pr-5" : "pr-3"} ${right(column) ? "text-right" : ""}`}>
                        {index === 0 ? "Total" : column.key in report.totals ? <Money paise={report.totals[column.key]!} withPaise /> : null}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        )}
      </SectionCard>
    </PageContainer>
  );
}
