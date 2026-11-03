import { cashChange } from "@/shared/invoice";
import { parseRupeesToPaise } from "@/shared/money";
import type { MessageKey } from "@/shared/i18n/messages/en";

/**
 * The bill being written at the counter. Everything a cashier types lives here, so "New bill" and a
 * successful save replace it in one step, and each draft carries its own Idempotency-Key: retries of
 * the same draft replay the saved bill, a new draft can never replay an old one.
 */
export type Method = "cash" | "upi" | "card" | "bank";
export type BillingProblem = { code: string; field?: string; message: string };
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

export function billingBannerProblems(problems: readonly BillingProblem[]): BillingProblem[] {
  return problems.filter((problem) => !problem.field?.startsWith("lines.") && problem.field !== "cashReceived" && problem.field !== "customerId");
}

/** The same words the server gives for an amount it can't read (billInputSchema), so the cashier sees them before asking the server. */
const UNREADABLE: Record<Method | "cashReceived", MessageKey> = {
  cash: "server.enterCash",
  upi: "server.enterUpi",
  card: "server.enterCard",
  bank: "server.enterBank",
  cashReceived: "server.enterCashReceived",
};

/**
 * Amounts that can't be read as rupees, by field. Empty is fine (nothing paid by that method). The typed text is never changed:
 * the cashier corrects it. Only unreadable text is judged here; everything else (too much paid, credit rules) is the server's.
 */
export function unreadableAmounts(draft: Pick<Draft<unknown>, "payments" | "cashReceived">): Partial<Record<Method | "cashReceived", MessageKey>> {
  const found: Partial<Record<Method | "cashReceived", MessageKey>> = {};
  for (const field of ["cash", "upi", "card", "bank"] as const) {
    const text = draft.payments[field].trim();
    if (text !== "" && parseRupeesToPaise(text) === null) found[field] = UNREADABLE[field];
  }
  const received = draft.cashReceived.trim();
  if (received !== "" && parseRupeesToPaise(received) === null) found.cashReceived = UNREADABLE.cashReceived;
  return found;
}
