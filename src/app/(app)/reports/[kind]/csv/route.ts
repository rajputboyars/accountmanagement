import { unstable_rethrow } from "next/navigation";
import { CSV_ROWS, getReport, reportToCsv } from "@/modules/reporting";
import { toActionError } from "@/server/action-result";
import { requireSession } from "@/server/auth";
import { isAppError } from "@/server/errors";
import { getLanguage, getT } from "@/server/i18n";
import { csvDownload, csvFileName } from "@/shared/csv";
import { localizeReport } from "@/shared/i18n/labels";

/** A report as CSV. Session, shop and permissions are checked by the reporting service; cells are formula-safe. */
export async function GET(request: Request, context: { params: Promise<{ kind: string }> }) {
  const { kind } = await context.params;
  const url = new URL(request.url);
  const param = (name: string) => url.searchParams.get(name) ?? undefined;
  try {
    const report = await getReport(await requireSession(), kind, { range: param("range"), from: param("from"), to: param("to") }, { limit: CSV_ROWS });
    const period = report.range ? (report.range.from === report.range.to ? report.range.from : `${report.range.from}-to-${report.range.to}`) : "today";
    const [t, language] = await Promise.all([getT(), getLanguage()]);
    const csv = reportToCsv(localizeReport(report, t, language), { total: t("common.total"), truncated: (count) => t("reports.csvTruncated", { count }) });
    return new Response(csvDownload(csv), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${csvFileName(report.kind)}-${period}.csv"`, "cache-control": "no-store" },
    });
  } catch (error) {
    unstable_rethrow(error);
    return new Response((await toActionError(error)).error, { status: isAppError(error) ? error.status : 500 });
  }
}
