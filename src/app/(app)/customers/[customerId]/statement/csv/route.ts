import { getCustomerAccount } from "@/modules/reporting";
import { toActionError } from "@/server/action-result";
import { unstable_rethrow } from "next/navigation";
import { requireSession } from "@/server/auth";
import { isAppError } from "@/server/errors";
import { csvFileName, csvRupees as rupees, toCsv } from "@/shared/csv";

/** Statement as CSV (session and permission checked by the reporting service; amounts in rupees, formula-safe cells). */
export async function GET(request: Request, context: { params: Promise<{ customerId: string }> }) {
  const { customerId } = await context.params;
  const url = new URL(request.url);
  try {
    const account = await getCustomerAccount(await requireSession(), customerId, { from: url.searchParams.get("from") ?? "", to: url.searchParams.get("to") ?? "" });
    const rows = [
      ["Date", "Entry", "Debit", "Credit", "Balance"],
      ...(account.from ? [[account.from, "Brought forward", "", "", rupees(account.broughtForwardPaise)]] : []),
      ...account.statement.map((line) => [line.entryDate, line.description, line.debitPaise ? rupees(line.debitPaise) : "", line.creditPaise ? rupees(line.creditPaise) : "", rupees(line.balancePaise)]),
    ];
    const csv = toCsv(rows);
    const safeName = csvFileName(account.customer.name);
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="statement-${safeName}-${account.asOf}.csv"`, "cache-control": "no-store" } });
  } catch (error) {
    unstable_rethrow(error);
    return new Response(toActionError(error).error, { status: isAppError(error) ? error.status : 500 });
  }
}
