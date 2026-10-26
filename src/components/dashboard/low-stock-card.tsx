import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { SectionCard } from "@/components/nexora/section-card";
import type { StockAlert } from "@/demo/dashboard-summary";

export function LowStockCard({ alerts }: { alerts: readonly StockAlert[] }) {
  return (
    <SectionCard
      title="Low stock"
      description="At or below the reorder level"
      action={
        <Link href="/inventory" className={buttonVariants({ variant: "outline", size: "sm" })}>
          View stock
        </Link>
      }
    >
      {alerts.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Every item is above its reorder level.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {alerts.map((item) => (
            <li key={item.sku} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium text-foreground">{item.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  Reorder at {item.reorderLevel} {item.unit}
                </span>
              </div>
              <Badge variant={item.severity === "reorder-now" ? "danger" : "warning"} className="h-6 px-2.5 tabular-nums">
                {item.stock} {item.unit} left
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
