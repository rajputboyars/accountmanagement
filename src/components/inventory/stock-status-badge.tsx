import { Badge } from "@/components/ui/badge";
import type { StockStatus } from "@/modules/inventory";
import { getT } from "@/server/i18n";
import type { MessageKey } from "@/shared/i18n";

export const STOCK_STATUS_LABEL: Record<StockStatus, MessageKey> = {
  healthy: "stock.status.healthy",
  low: "stock.status.low",
  reorder: "stock.status.reorder",
  out: "stock.status.out",
  uncounted: "stock.status.uncounted",
  needs_check: "stock.status.needsCheck",
};

const VARIANT = { healthy: "success", low: "warning", reorder: "danger", out: "danger", uncounted: "neutral", needs_check: "warning" } as const;

export async function StockStatusBadge({ status }: { status: StockStatus }) {
  const t = await getT();
  return <Badge variant={VARIANT[status]}>{t(STOCK_STATUS_LABEL[status])}</Badge>;
}
