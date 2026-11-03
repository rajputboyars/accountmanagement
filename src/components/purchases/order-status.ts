import type { MessageKey } from "@/shared/i18n";

/** Plain-language labels for purchase order statuses (spec S2: "Received · short"). */
export const ORDER_STATUS: Record<string, { label: MessageKey; variant: "info" | "warning" | "success" | "neutral" }> = {
  ordered: { label: "purchases.status.ordered", variant: "info" },
  partially_received: { label: "purchases.status.partial", variant: "warning" },
  received: { label: "purchases.status.received", variant: "success" },
  closed: { label: "purchases.status.closed", variant: "neutral" },
  cancelled: { label: "purchases.status.cancelled", variant: "neutral" },
};
