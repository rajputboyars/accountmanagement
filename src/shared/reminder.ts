import { formatPaise } from "./money";

/** Facts for a dues reminder, all taken from the customer's own ledger and the shop's settings. */
export type ReminderFacts = {
  customerName: string;
  shopName: string;
  shopPhone: string | null;
  upiId: string | null;
  balancePaise: number;
  overduePaise: number;
  oldest: { label: string; date: string; remainingPaise: number } | null;
  asOf: string;
};

const dateText = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));

/**
 * A polite Hinglish WhatsApp reminder. Amounts are passed in already worked out from the ledger,
 * so the message always matches the account screen. Pure: the person reviews it and sends it.
 */
export function duesReminderText(facts: ReminderFacts): string {
  const money = (paise: number) => formatPaise(paise, { withPaise: true });
  return [
    `Namaste ${facts.customerName} ji 🙏`,
    `${facts.shopName} ki taraf se ek chhota sa reminder.`,
    `${dateText(facts.asOf)} tak aapka baaki (udhaar) ${money(facts.balancePaise)} hai.`,
    facts.overduePaise > 0 ? `Isme se ${money(facts.overduePaise)} 30 din se zyada purana hai.` : null,
    facts.oldest ? `Sabse purana bill: ${facts.oldest.label} (${dateText(facts.oldest.date)}), baaki ${money(facts.oldest.remainingPaise)}.` : null,
    `Jab suvidha ho, payment kar dijiye.${facts.upiId ? ` UPI: ${facts.upiId}` : ""}`,
    facts.shopPhone ? `Koi sawaal ho to ${facts.shopPhone} par call karein.` : null,
    "",
    "Dhanyavaad,",
    facts.shopName,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** Facts for a bill summary shared on WhatsApp, all from the saved bill and the shop's settings. */
export type BillShareFacts = {
  shopName: string;
  shopPhone: string | null;
  upiId: string | null;
  /** null for a walk-in sale. */
  customerName: string | null;
  number: string;
  date: string;
  totalPaise: number;
  paidPaise: number;
};

/** A short Hinglish bill summary the cashier can send from their own WhatsApp. Pure. */
export function billShareText(facts: BillShareFacts): string {
  const money = (paise: number) => formatPaise(paise, { withPaise: true });
  const due = facts.totalPaise - facts.paidPaise;
  return [
    facts.customerName ? `Namaste ${facts.customerName} ji 🙏` : "Namaste 🙏",
    `${facts.shopName} se aapka bill ${facts.number} (${dateText(facts.date)}):`,
    `Bill amount: ${money(facts.totalPaise)}`,
    facts.paidPaise > 0 ? `Payment mila: ${money(facts.paidPaise)}` : null,
    due > 0 ? `Is bill ka baaki (udhaar): ${money(due)}${facts.upiId ? ` · UPI: ${facts.upiId}` : ""}` : "Pura payment ho gaya.",
    facts.shopPhone ? `Koi sawaal ho to ${facts.shopPhone} par call karein.` : null,
    "",
    "Dhanyavaad,",
    facts.shopName,
  ]
    .filter((line) => line !== null)
    .join("\n");
}
