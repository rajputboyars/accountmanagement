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
import { getLanguage, getT } from "@/server/i18n";
import { indiaDate } from "@/shared/financial-year";
import { billDate, localizeReport, rangeLabel } from "@/shared/i18n/labels";
import type { Language } from "@/shared/i18n";
import { rangeQuery } from "@/shared/report-range";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("reports.pageTitle") };
}

type Props = PageProps<"/reports/[kind]">;

export default function ReportPage({ params, searchParams }: Props) {
  return (
    <ProtectedPage permission="reports.view" title="this report">
      <ReportView params={params} searchParams={searchParams} />
    </ProtectedPage>
  );
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

function Cell({ column, value, language }: { column: ReportColumn; value: string | number | null | undefined; language: Language }) {
  if (value === null || value === undefined || value === "") return <span className="text-muted-foreground">—</span>;
  if (column.type === "money") return <Money paise={Number(value)} withPaise />;
  if (column.type === "date") return <span className="whitespace-nowrap">{billDate(String(value), language)}</span>;
  if (column.type === "qty") return <span className="tabular-nums">{Number(value).toLocaleString("en-IN", { maximumFractionDigits: 3 })}</span>;
  return <>{value}</>;
}

const right = (column: ReportColumn) => column.type === "money" || column.type === "qty";

/** On phones the first column heads the row and the first figure stays beside it (see .stack-table). */
const stackProps = (columns: ReportColumn[], index: number) =>
  index === 0 ? { "data-title": true } : { "data-label": columns[index]!.label, ...(index === columns.findIndex(right) ? { "data-key": true } : {}) };

async function ReportView({ params, searchParams }: Props) {
  const [{ kind }, query, session] = await Promise.all([params, searchParams, requireSession()]);
  const [t, language] = await Promise.all([getT(), getLanguage()]);
  const found = await getReport(session, kind, { range: one(query.range), from: one(query.from), to: one(query.to) }).catch((error: unknown) => {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) return error;
    throw error;
  });
  const report = "columns" in found ? localizeReport(found, t, language) : found;
  if (!("columns" in report)) {
    return (
      <PageContainer className="max-w-4xl">
        <SectionCard title={t(report instanceof ForbiddenError ? "reports.denied" : "reports.notFound")} description={report instanceof ForbiddenError ? t("reports.askOwner") : undefined}>
          <Link href="/reports" className="text-sm font-semibold text-teal-strong hover:underline">
            {t("reports.back")}
          </Link>
        </SectionCard>
      </PageContainer>
    );
  }
  const suffix = report.range ? `?${rangeQuery(report.range)}` : "";
  const hasTotals = Object.keys(report.totals).length > 0;
  const rows = t(report.rows.length === 1 ? "reports.rowCountOne" : "reports.rowCount", { count: report.rows.length });
  return (
    <PageContainer>
      <Link href={`/reports${suffix}`} className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("nav.reports.label")}
      </Link>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{report.title}</h1>
          <p className="text-sm text-muted-foreground">{report.description}</p>
        </div>
        <a href={`/reports/${report.kind}/csv${suffix}`} download className={buttonVariants({ variant: "outline", size: "touch" })}>
          <Download aria-hidden="true" />
          {t("reports.exportCsv")}
        </a>
      </div>
      {report.range ? <RangeFilter basePath={`/reports/${report.kind}`} range={report.range} today={indiaDate()} /> : null}
      <SectionCard title={report.range ? rangeLabel(t, report.range) : t("reports.asOfToday")} description={report.truncated ? t("reports.truncated", { rows }) : rows} flush>
        {report.rows.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-muted-foreground">{t("reports.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="stack-table stack-table-flush w-full min-w-[40rem] text-sm">
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
                      <td key={column.key} {...stackProps(report.columns, index)} className={`py-2 ${index === 0 ? "pl-5" : "pl-3"} ${index === report.columns.length - 1 ? "pr-5" : "pr-3"} ${right(column) ? "text-right" : ""}`}>
                        {index === 0 && row.href ? (
                          <Link href={row.href} className="font-medium text-teal-strong hover:underline">
                            <Cell column={column} value={row.cells[column.key]} language={language} />
                          </Link>
                        ) : (
                          <Cell column={column} value={row.cells[column.key]} language={language} />
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
                      <td key={column.key} {...stackProps(report.columns, index)} className={`py-2.5 ${index === 0 ? "pl-5" : "pl-3"} ${index === report.columns.length - 1 ? "pr-5" : "pr-3"} ${right(column) ? "text-right" : ""}`}>
                        {index === 0 ? t("common.total") : column.key in report.totals ? <Money paise={report.totals[column.key]!} withPaise /> : null}
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
