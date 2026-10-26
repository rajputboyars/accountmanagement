/**
 * Cash drawer maths (Product spec §7 "Expected cash", handoff C13). Pure integer paise.
 *
 *   expected = opening cash
 *            + cash taken on bills + old dues paid in cash + cash put into the drawer
 *            − cash refunds − cash paid to suppliers (+ reversed supplier payments) − cash expenses
 *            − cash taken out (owner withdrawal, bank deposit)
 *   difference = counted − expected  (negative: "Cash short", positive: "Cash extra")
 *
 * Only cash counts. UPI, card, bank and cheque never touch the drawer, and a credit sale brings in
 * no money at all. Cash flow is not profit.
 *
 * Spec example: ₹5,000 + ₹11,800 + ₹6,400 − ₹850 − ₹4,000 = ₹18,350 expected; counted ₹18,150 → −₹200.
 */

import type { Paise } from "./money";

export type CashFlows = {
  openingPaise: Paise;
  cashSalesPaise: Paise;
  cashCollectionsPaise: Paise;
  cashAddedPaise: Paise;
  cashRefundsPaise: Paise;
  supplierCashPaidPaise: Paise;
  supplierCashReturnedPaise: Paise;
  cashExpensesPaise: Paise;
  cashWithdrawnPaise: Paise;
};

export function expectedCash(flows: CashFlows): Paise {
  return (
    flows.openingPaise +
    flows.cashSalesPaise +
    flows.cashCollectionsPaise +
    flows.cashAddedPaise -
    flows.cashRefundsPaise -
    flows.supplierCashPaidPaise +
    flows.supplierCashReturnedPaise -
    flows.cashExpensesPaise -
    flows.cashWithdrawnPaise
  );
}

/** Net effect of a day's cash flows on the drawer (everything except the opening figure). */
export function netCashFlow(flows: Omit<CashFlows, "openingPaise">): Paise {
  return expectedCash({ ...flows, openingPaise: 0 });
}

export type DrawerResult = { differencePaise: Paise; label: "matches" | "short" | "extra" };

export function drawerResult(expectedPaise: Paise, countedPaise: Paise): DrawerResult {
  const differencePaise = countedPaise - expectedPaise;
  return { differencePaise, label: differencePaise === 0 ? "matches" : differencePaise < 0 ? "short" : "extra" };
}

/** Handoff C18: fixed categories; "Other" needs a note. */
export const EXPENSE_CATEGORIES = [
  { key: "rent", label: "Rent" },
  { key: "salary", label: "Salary" },
  { key: "transport", label: "Transport" },
  { key: "electricity", label: "Electricity" },
  { key: "tea", label: "Tea & snacks" },
  { key: "other", label: "Other" },
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]["key"];

/** Spec §7: a reason must be chosen for any difference. */
export const DIFFERENCE_REASONS = [
  { key: "change_short", label: "Change given short" },
  { key: "unrecorded_expense", label: "Unrecorded expense" },
  { key: "counting_mistake", label: "Counting mistake" },
  { key: "other", label: "Other" },
] as const;
