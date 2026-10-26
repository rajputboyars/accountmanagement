import { unstable_rethrow } from "next/navigation";
import { importProblemRows } from "@/modules/imports";
import { toActionError } from "@/server/action-result";
import { requireSession } from "@/server/auth";
import { isAppError } from "@/server/errors";
import { toCsv } from "@/shared/csv";

/** Rows left out of an import, with the original columns and the reason, ready to fix and upload again. */
export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  try {
    const { headers, rows } = await importProblemRows(await requireSession(), jobId);
    const csv = toCsv([[...headers, "row", "problem"], ...rows.map((row) => [...headers.map((_, index) => row.cells[index] ?? ""), row.rowNo, row.problem])]);
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="import-problems-${jobId.slice(0, 8)}.csv"`, "cache-control": "no-store" } });
  } catch (error) {
    unstable_rethrow(error);
    return new Response(toActionError(error).error, { status: isAppError(error) ? error.status : 500 });
  }
}
