/**
 * Which bills are still unpaid, and how old (Product spec §4 "Which bills are still unpaid").
 * Pure: the caller passes a party's ledger entries; nothing here is stored. Every payment, credit
 * note or other credit is applied to the oldest open debit first. A credit left over after every
 * debit is paid is an advance. Balances still come from SUM(debit − credit); this only explains them.
 *
 * Spec example: bills ₹48,000 (10 Sep) + ₹34,000 (9 Oct), payments ₹20,000 → the 10 Sep bill has
 * ₹28,000 left and is 45 days old on 25 Oct (overdue); the 9 Oct bill is unpaid, 16 days old.
 */

import type { Paise } from "./money";

export type AgeingEntry = { id: string; date: string; debitPaise: Paise; creditPaise: Paise; label: string };
export type OpenItem = { id: string; date: string; label: string; amountPaise: Paise; remainingPaise: Paise; ageDays: number; dueDate: string; daysPastDue: number };
export type AgeingBuckets = { notDuePaise: Paise; days1to30Paise: Paise; days31to60Paise: Paise; days61to90Paise: Paise; over90Paise: Paise };

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * @param termsDays days until a debit falls due (customers: the 30-day overdue threshold, spec
 *        assumption; suppliers: their payment terms).
 */
export function ageOpenItems(entries: readonly AgeingEntry[], asOf: string, termsDays: number): { open: OpenItem[]; advancePaise: Paise; buckets: AgeingBuckets; overduePaise: Paise; oldestOverdueDays: number | null } {
  const sorted = [...entries].sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? -1 : 1));
  const debits = sorted.filter((entry) => entry.debitPaise > 0).map((entry) => ({ ...entry, remaining: entry.debitPaise }));
  let credit = sorted.reduce((sum, entry) => sum + entry.creditPaise, 0);
  for (const debit of debits) {
    const used = Math.min(credit, debit.remaining);
    debit.remaining -= used;
    credit -= used;
  }
  const buckets: AgeingBuckets = { notDuePaise: 0, days1to30Paise: 0, days31to60Paise: 0, days61to90Paise: 0, over90Paise: 0 };
  const open = debits
    .filter((debit) => debit.remaining > 0)
    .map((debit) => {
      const dueDate = addDays(debit.date, termsDays);
      const daysPastDue = Math.max(0, daysBetween(dueDate, asOf));
      if (daysPastDue === 0) buckets.notDuePaise += debit.remaining;
      else if (daysPastDue <= 30) buckets.days1to30Paise += debit.remaining;
      else if (daysPastDue <= 60) buckets.days31to60Paise += debit.remaining;
      else if (daysPastDue <= 90) buckets.days61to90Paise += debit.remaining;
      else buckets.over90Paise += debit.remaining;
      return { id: debit.id, date: debit.date, label: debit.label, amountPaise: debit.debitPaise, remainingPaise: debit.remaining, ageDays: Math.max(0, daysBetween(debit.date, asOf)), dueDate, daysPastDue };
    });
  const overdue = open.filter((item) => item.daysPastDue > 0);
  return {
    open,
    advancePaise: credit,
    buckets,
    overduePaise: overdue.reduce((sum, item) => sum + item.remainingPaise, 0),
    oldestOverdueDays: overdue.length ? Math.max(...overdue.map((item) => item.ageDays)) : null,
  };
}

/** Spec §4: red above 30 days, amber above 10, green when paid up. */
export function dueTone(oldestAgeDays: number | null, balancePaise: Paise): "paid" | "ok" | "amber" | "red" {
  if (balancePaise <= 0) return "paid";
  if (oldestAgeDays === null) return "ok";
  return oldestAgeDays > 30 ? "red" : oldestAgeDays > 10 ? "amber" : "ok";
}
