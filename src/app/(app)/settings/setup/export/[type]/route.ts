import { unstable_rethrow } from "next/navigation";
import { exportRows } from "@/modules/imports";
import { toActionError } from "@/server/action-result";
import { requireSession } from "@/server/auth";
import { isAppError } from "@/server/errors";
import { toCsv } from "@/shared/csv";
import { indiaDate } from "@/shared/financial-year";

/** The shop's products, customers or suppliers as CSV. The imports service checks the viewing permission; cells are formula-safe. */
export async function GET(_request: Request, context: { params: Promise<{ type: string }> }) {
  const { type } = await context.params;
  try {
    const data = await exportRows(await requireSession(), type);
    return new Response(toCsv(data.rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="nexora-${data.type}-${indiaDate()}.csv"`, "cache-control": "no-store" } });
  } catch (error) {
    unstable_rethrow(error);
    return new Response(toActionError(error).error, { status: isAppError(error) ? error.status : 500 });
  }
}
