import { getCustomerAccount } from "@/modules/reporting";
import { toActionError } from "@/server/action-result";
import { unstable_rethrow } from "next/navigation";
import { requireSession } from "@/server/auth";
import { isAppError } from "@/server/errors";

/** Statement as CSV (session and permission checked by the reporting service; amounts in rupees). */
export async function GET(request: Request, context: { params: Promise<{ customerId: string }> }) {
  const { customerId } = await context.params;
  const url = new URL(request.url);
  try {
    const account = await getCustomerAccount(await requireSession(), customerId, { from: url.searchParams.get("from") ?? "", to: url.searchParams.get("to") ?? "" });
    // Integer formatting, no float division: -1234 paise → "-12.34".
    const rupees = (paise: number) => `${paise < 0 ? "-" : ""}${Math.floor(Math.abs(paise) / 100)}.${String(Math.abs(paise) % 100).padStart(2, "0")}`;
    const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const rows = [
      ["Date", "Entry", "Debit", "Credit", "Balance"],
      ...(account.from ? [[account.from, "Brought forward", "", "", rupees(account.broughtForwardPaise)]] : []),
      ...account.statement.map((line) => [line.entryDate, line.description, line.debitPaise ? rupees(line.debitPaise) : "", line.creditPaise ? rupees(line.creditPaise) : "", rupees(line.balancePaise)]),
    ];
    const csv = rows.map((row) => row.map(cell).join(",")).join("\r\n");
    const safeName = account.customer.name.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40);
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="statement-${safeName}-${account.asOf}.csv"`, "cache-control": "no-store" } });
  } catch (error) {
    unstable_rethrow(error);
    return new Response(toActionError(error).error, { status: isAppError(error) ? error.status : 500 });
  }
}
