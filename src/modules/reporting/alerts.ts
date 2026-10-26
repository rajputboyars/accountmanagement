import { hasPermission, raiseNotification, type SessionContext } from "@/modules/identity";
import { stockAlerts } from "@/modules/inventory";
import { indiaDate } from "@/shared/financial-year";
import { formatPaise } from "@/shared/money";
import { addDays } from "@/shared/report-range";
import { listReceivables } from "./accounts";

/**
 * Business alerts worked out from the authoritative records (stock movements, the ledger) when an
 * owner or manager opens the dashboard or notifications. Each is a summary with a dedupe key, so it is
 * raised at most once a day (stock) or once a week (dues) however often pages load. Only what the
 * viewer may see is checked; recipients are everyone in the shop with the matching permission.
 */
export async function refreshBusinessAlerts(session: SessionContext) {
  const today = indiaDate();
  const weekStart = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7)); // Monday
  let raised = 0;
  if (await hasPermission(session, "inventory.view")) {
    const { counts } = await stockAlerts(session, 0);
    if (counts.out + counts.reorder > 0) {
      raised += await raiseNotification({
        shopId: session.shopId,
        kind: "low_stock",
        title: "Stock needs reordering",
        body: `${counts.out} out of stock · ${counts.reorder} below half the reorder level · ${counts.low} low.`,
        href: "/reports/stock",
        dedupeKey: `low_stock:${today}`,
        to: { permission: "inventory.view" },
      });
    }
  }
  if (await hasPermission(session, "customers.view")) {
    const { rows, totals } = await listReceivables(session, today);
    const overdue = rows.filter((row) => row.overduePaise > 0);
    if (overdue.length > 0) {
      raised += await raiseNotification({
        shopId: session.shopId,
        kind: "dues_overdue",
        title: `${overdue.length} ${overdue.length === 1 ? "customer has" : "customers have"} overdue bills`,
        body: `${formatPaise(totals.overduePaise)} overdue (bills older than 30 days). Highest: ${overdue[0]!.name}.`,
        href: "/reports/customer-dues",
        dedupeKey: `dues_overdue:${weekStart}`,
        to: { permission: "customers.edit" },
      });
    }
  }
  return raised;
}
