import { translatorFor, type Language } from "./i18n";
import { billDate, statementLabel } from "./i18n/labels";
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

/**
 * A polite WhatsApp reminder in the customer's language. Amounts are passed in already worked out from the
 * ledger, so the message always matches the account screen. Pure: the person reviews it and sends it.
 */
export function duesReminderText(facts: ReminderFacts, language: Language = "hinglish"): string {
  const t = translatorFor(language);
  const money = (paise: number) => formatPaise(paise, { withPaise: true });
  return [
    t("message.greetingName", { name: facts.customerName }),
    t("message.reminder.intro", { shop: facts.shopName }),
    t("message.reminder.balance", { date: billDate(facts.asOf, language), amount: money(facts.balancePaise) }),
    facts.overduePaise > 0 ? t("message.reminder.overdue", { amount: money(facts.overduePaise) }) : null,
    facts.oldest ? t("message.reminder.oldest", { label: statementLabel(facts.oldest.label, language), date: billDate(facts.oldest.date, language), amount: money(facts.oldest.remainingPaise) }) : null,
    facts.upiId ? t("message.reminder.payUpi", { upi: facts.upiId }) : t("message.reminder.pay"),
    facts.shopPhone ? t("message.call", { phone: facts.shopPhone }) : null,
    "",
    t("message.thanks"),
    facts.shopName,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** What a queued message keeps so it can be written at sending time. A custom message has none. */
export type QueuedTemplate = { kind: "dues_reminder"; facts: ReminderFacts };

/**
 * The words to send for a queued message: a standard reminder in the customer's current language, with the
 * figures frozen when it was queued. A message without a template (custom, or queued earlier) goes as saved.
 */
export function queuedMessageText(message: { body: string; template: QueuedTemplate | null }, language: Language): string {
  return message.template?.kind === "dues_reminder" ? duesReminderText(message.template.facts, language) : message.body;
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

/**
 * A short bill summary the cashier can send from their own WhatsApp. The language is the customer's and must
 * be passed in: it is never taken from the screen language of the person sending. Pure.
 */
export function billShareText(facts: BillShareFacts, language: Language): string {
  const t = translatorFor(language);
  const money = (paise: number) => formatPaise(paise, { withPaise: true });
  const due = facts.totalPaise - facts.paidPaise;
  return [
    facts.customerName ? t("message.greetingName", { name: facts.customerName }) : t("message.greeting"),
    t("message.bill.intro", { shop: facts.shopName, number: facts.number, date: billDate(facts.date, language) }),
    t("message.bill.amount", { amount: money(facts.totalPaise) }),
    facts.paidPaise > 0 ? t("message.bill.paid", { amount: money(facts.paidPaise) }) : null,
    due > 0 ? (facts.upiId ? t("message.bill.dueUpi", { amount: money(due), upi: facts.upiId }) : t("message.bill.due", { amount: money(due) })) : t("message.bill.paidFull"),
    facts.shopPhone ? t("message.call", { phone: facts.shopPhone }) : null,
    "",
    t("message.thanks"),
    facts.shopName,
  ]
    .filter((line) => line !== null)
    .join("\n");
}
