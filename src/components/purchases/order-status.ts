/** Plain-language labels for purchase order statuses (spec S2: "Received · short"). */
export const ORDER_STATUS: Record<string, { label: string; variant: "info" | "warning" | "success" | "neutral" }> = {
  ordered: { label: "Ordered", variant: "info" },
  partially_received: { label: "Received · short", variant: "warning" },
  received: { label: "Received", variant: "success" },
  closed: { label: "Closed short", variant: "neutral" },
  cancelled: { label: "Cancelled", variant: "neutral" },
};
