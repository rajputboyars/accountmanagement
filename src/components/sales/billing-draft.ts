import { cashChange } from "@/shared/invoice";
import { parseRupeesToPaise } from "@/shared/money";

/**
 * The bill being written at the counter. Everything a cashier types lives here, so "New bill" and a
 * successful save replace it in one step, and each draft carries its own Idempotency-Key: retries of
 * the same draft replay the saved bill, a new draft can never replay an old one.
 */
export type Method = "cash" | "upi" | "card" | "bank";
export type DraftLine<P> = { key: number; product: P; unit: string; quantity: string };
export type Draft<P> = {
  customerId: string;
  priceList: string;
  discountPercent: string;
  placeOfSupply: string;
  lines: DraftLine<P>[];
  payments: Record<Method, string>;
  cashReceived: string;
  idempotencyKey: string;
};

export const newIdempotencyKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : `${Date.now()}${Math.random().toString(36).slice(2)}`;

export function emptyDraft<P>(): Draft<P> {
  return { customerId: "", priceList: "", discountPercent: "", placeOfSupply: "", lines: [], payments: { cash: "", upi: "", card: "", bank: "" }, cashReceived: "", idempotencyKey: newIdempotencyKey() };
}

/**
 * Change shown while typing, before the server preview returns. Display only: the server works out
 * change again and refuses a bill whose cash received is short. Unreadable amounts → null.
 */
export function cashSummary(cash: string, cashReceived: string): { changePaise: number; shortPaise: number } | null {
  if (!cashReceived.trim()) return null;
  const due = cash.trim() ? parseRupeesToPaise(cash) : 0;
  const received = parseRupeesToPaise(cashReceived);
  if (due === null || received === null) return null;
  return cashChange(due, received);
}
