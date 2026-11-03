import { getCustomerAccount } from "@/modules/reporting";
import { toActionError } from "@/server/action-result";
import { unstable_rethrow } from "next/navigation";
import { requireSession } from "@/server/auth";
import { isAppError } from "@/server/errors";
import { getLanguage, getT } from "@/server/i18n";
import { csvDownload, csvFileName, csvRupees as rupees, toCsv } from "@/shared/csv";
import { statementLabel } from "@/shared/i18n/labels";

/** Statement as CSV (session and permission checked by the reporting service; amounts in rupees, formula-safe cells). */
export async function GET(request: Request, context: { params: Promise<{ customerId: string }> }) {
  const { customerId } = await context.params;
  const url = new URL(request.url);
  try {
    const account = await getCustomerAccount(await requireSession(), customerId, { from: url.searchParams.get("from") ?? "", to: url.searchParams.get("to") ?? "" });
    const [t, language] = await Promise.all([getT(), getLanguage()]);
    const rows = [
      [t("common.date"), t("csv.entry"), t("csv.debit"), t("csv.credit"), t("csv.balance")],
      ...(account.from ? [[account.from, t("csv.broughtForward"), "", "", rupees(account.broughtForwardPaise)]] : []),
      ...account.statement.map((line) => [line.entryDate, statementLabel(line.description, language), line.debitPaise ? rupees(line.debitPaise) : "", line.creditPaise ? rupees(line.creditPaise) : "", rupees(line.balancePaise)]),
    ];
    const csv = csvDownload(toCsv(rows));
    const safeName = csvFileName(account.customer.name);
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="statement-${safeName}-${account.asOf}.csv"`, "cache-control": "no-store" } });
  } catch (error) {
    unstable_rethrow(error);
    return new Response((await toActionError(error)).error, { status: isAppError(error) ? error.status : 500 });
  }
}
