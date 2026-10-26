import { unstable_rethrow } from "next/navigation";
import { IMPORT_RUN, IMPORT_TYPES, templateCsvRows, type ImportType } from "@/modules/imports";
import { requirePermission } from "@/modules/identity";
import { toActionError } from "@/server/action-result";
import { requireSession } from "@/server/auth";
import { isAppError } from "@/server/errors";
import { toCsv } from "@/shared/csv";

/** Blank import template: header row of field keys plus one example row. */
export async function GET(_request: Request, context: { params: Promise<{ type: string }> }) {
  const { type } = await context.params;
  try {
    await requirePermission(await requireSession(), IMPORT_RUN);
    if (!(IMPORT_TYPES as readonly string[]).includes(type)) return new Response("There is no such template.", { status: 404 });
    return new Response(toCsv(templateCsvRows(type as ImportType)), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="nexora-${type}-template.csv"`, "cache-control": "no-store" } });
  } catch (error) {
    unstable_rethrow(error);
    return new Response(toActionError(error).error, { status: isAppError(error) ? error.status : 500 });
  }
}
