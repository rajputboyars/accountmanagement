import { Badge } from "@/components/ui/badge";
import type { StockStatus } from "@/modules/inventory";

export const STOCK_STATUS_LABEL: Record<StockStatus, string> = {
  healthy: "In stock",
  low: "Low",
  reorder: "Reorder now",
  out: "Out of stock",
  uncounted: "Not counted yet",
  needs_check: "Needs check",
};

const VARIANT = { healthy: "success", low: "warning", reorder: "danger", out: "danger", uncounted: "neutral", needs_check: "warning" } as const;

export function StockStatusBadge({ status }: { status: StockStatus }) {
  return <Badge variant={VARIANT[status]}>{STOCK_STATUS_LABEL[status]}</Badge>;
}
