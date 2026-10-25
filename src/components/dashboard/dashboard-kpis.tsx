import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/nexora/kpi-card";
import { Money } from "@/components/nexora/money";
import type { DashboardSummary } from "@/demo/dashboard-summary";
import { formatPaise } from "@/shared/money";

/** Four separate answers: what we billed, what came in, what is owed, and whether profit can be trusted. */
export function DashboardKpis({ summary }: { summary: DashboardSummary }) {
  const { sales, collections, dues, profit } = summary;
  const retailShare = sales.totalPaise > 0 ? (sales.retailPaise / sales.totalPaise) * 100 : 0;

  return (
    <section aria-label="Today's key numbers" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <KpiCard
        label="Sales today"
        href="/reports"
        value={<Money paise={sales.totalPaise} />}
        detail={`${sales.billCount} bills · ${formatPaise(sales.creditGivenPaise)} sold on credit`}
        footer={
          <div className="flex flex-col gap-2">
            <div className="flex h-2 gap-1 overflow-hidden rounded-full" aria-hidden="true">
              <div className="rounded-full bg-chart-1" style={{ width: `${retailShare}%` }} />
              <div className="flex-1 rounded-full bg-teal" />
            </div>
            <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
              <span>
                <span className="mr-1.5 inline-block size-2 rounded-full bg-chart-1" aria-hidden="true" />
                Retail {formatPaise(sales.retailPaise)}
              </span>
              <span>
                <span className="mr-1.5 inline-block size-2 rounded-full bg-teal" aria-hidden="true" />
                Wholesale {formatPaise(sales.wholesalePaise)}
              </span>
            </div>
          </div>
        }
      />
      <KpiCard
        label="Collected today"
        href="/customers"
        value={<Money paise={collections.totalPaise} />}
        detail={
          <span className="tabular-nums">
            Cash {formatPaise(collections.byMethod.Cash)} · UPI {formatPaise(collections.byMethod.UPI)} · Bank{" "}
            {formatPaise(collections.byMethod.Bank)}
          </span>
        }
        footer={<Badge variant="neutral">Includes {formatPaise(collections.oldDuesPaise)} of old dues</Badge>}
      />
      <KpiCard
        label="Customer dues"
        href="/customers"
        value={<Money paise={dues.totalPaise} />}
        detail={`${dues.customersOwing} customers owe you, all time`}
        footer={<Badge variant="danger">{dues.overdueCount} overdue over 30 days</Badge>}
      />
      <KpiCard
        label="Gross profit today"
        href="/inventory"
        value={profit.reliable ? <Money paise={profit.grossProfitPaise} /> : <span className="text-xl text-muted-foreground">Not available</span>}
        detail={
          profit.reliable
            ? "Every item sold has a cost price"
            : `Cost price missing for ${profit.itemsMissingCost.join(", ")}`
        }
        footer={profit.reliable ? null : <Badge variant="warning">Add cost prices to see profit</Badge>}
      />
    </section>
  );
}
