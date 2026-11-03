import type { MessageKey } from "./messages/en";
import type { Translate } from "./translate";

/** Every contextual help topic, by area. Each needs title, short, what, when and example in all three dictionaries. */
export const HELP_TOPICS = [
  "creditSale", "partialPayment", "discount", "specialPrice", "grossProfit", "amountInWords",
  "outstanding", "overdue", "creditLimit", "advancePayment", "paymentReceived", "refundVsReversal",
  "purchasePrice", "sellingPrice", "goodsReceived", "supplierBalance", "purchaseOrder",
  "openingStock", "availableStock", "lowStock", "reorderLevel", "stockAdjustment", "stockValuation", "unitsQuantities",
  "cashInOut", "openingCash", "closingCash", "cashDifference", "expenses", "grossVsTotalProfit",
  // One per module: the first-time tip and the "About this screen" help use the same words.
  "moduleDashboard", "moduleCustomers", "moduleBilling", "modulePurchases", "moduleSuppliers", "moduleInventory", "modulePricing", "modulePayments", "moduleCashbook", "moduleReports", "moduleApprovals", "moduleNotifications", "moduleSettings",
] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];

/** The topics that also carry a longer explanation, shown only when asked for. */
export const HELP_TOPICS_WITH_DETAIL = ["creditLimit", "refundVsReversal", "lowStock", "stockValuation", "cashDifference", "grossVsTotalProfit", "moduleBilling", "moduleCashbook"] as const satisfies readonly HelpTopic[];

export type HelpContent = { title: string; short: string; what: string; when: string; example: string; detail?: string };

export function isHelpTopic(topic: string): topic is HelpTopic {
  return (HELP_TOPICS as readonly string[]).includes(topic);
}

/** The wording for a topic in the translator's language. A topic that doesn't exist gives null, so no empty popup can show. */
export function helpContent(topic: string, t: Translate): HelpContent | null {
  if (!isHelpTopic(topic)) return null;
  const part = (name: "title" | "short" | "what" | "when" | "example") => t(`help.${topic}.${name}` satisfies MessageKey);
  const content: HelpContent = { title: part("title"), short: part("short"), what: part("what"), when: part("when"), example: part("example") };
  const withDetail = HELP_TOPICS_WITH_DETAIL.find((item) => item === topic);
  if (withDetail) content.detail = t(`help.${withDetail}.detail` satisfies MessageKey);
  return content;
}
