import { DIFFERENCE_REASONS, EXPENSE_CATEGORIES } from "@/shared/cashbook";
import type { ReportRange } from "@/shared/report-range";
import { expenseLabel } from "./expense-labels";
import { LANGUAGE_LOCALES, translateServerMessage } from "./index";
import type { Language } from "./languages";
import type { MessageKey } from "./messages/en";
import type { Translate } from "./translate";
import { unitShort } from "./unit-labels";

/** A business date such as "26 Oct 2026", in the person's language. */
export function billDate(value: string, language: Language): string {
  return new Intl.DateTimeFormat(LANGUAGE_LOCALES[language].dates, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

const SYSTEM_NAMES = new Set(["Walk-in customer", "Walk-in", "Customer", "Unknown product", "Unknown user", "Unknown customer", "Any customer"]);

/** Names Nexora itself supplied are translated; a name somebody entered is kept as written. */
export function systemName(name: string, language: Language): string {
  return SYSTEM_NAMES.has(name) ? translateServerMessage(name, language) : name;
}

/**
 * The saved rule behind a bill line: "Slab 50+ −1%", "Special ₹430", "Wholesale −2%". The record is unchanged;
 * only its words are shown in the person's language. Anything unrecognised is shown as saved.
 */
export function rateReasonLabel(reason: string, language: Language): string {
  const match = /^(.+?)( −[\d.]+%)?$/.exec(reason);
  return match ? `${translateServerMessage(match[1]!, language)}${match[2] ?? ""}` : reason;
}

/** A cancel reason is what someone typed. Only the prefix Nexora adds to a correction is ours to translate. */
export function cancelReasonLabel(reason: string, language: Language): string {
  return reason.startsWith("Corrected: ") ? translateServerMessage(reason, language) : reason;
}

const STATEMENT_METHODS: Record<string, string> = { CASH: "Cash", UPI: "UPI", BANK: "Bank", CHEQUE: "Cheque", CARD: "Card" };

/**
 * Statement lines are built from saved records: "Opening balance", "Cancelled INV/1", "REC/1 · CASH",
 * "Paid · BANK UTR123". The numbers and references stay as saved; only Nexora's own words are translated.
 */
export function statementLabel(label: string, language: Language): string {
  if (language === "en") return label;
  const parts = label.split(" · ");
  if (parts.length === 2) {
    const [method, ...reference] = parts[1]!.split(" ");
    const word = STATEMENT_METHODS[method!];
    if (word) return [translateServerMessage(parts[0]!, language), [translateServerMessage(word, language), ...reference].join(" ")].join(" · ");
  }
  return translateServerMessage(label, language);
}

/**
 * A stock entry's reason. Nexora writes some of them ("Cancelled INV/1: damaged"); only those words are
 * translated, and what somebody typed stays as written.
 */
export function movementReason(reason: string, language: Language): string {
  const ours = reason === "Opening stock" || /^(Cancelled .+: |Correction reversal for .+: )/.test(reason) || / \(corrects .+\)$/.test(reason) || /: returned damaged$/.test(reason);
  return ours ? translateServerMessage(reason, language) : reason;
}

type StockReportShape = { kind: string; title: string; description: string; columns: { key: string; label: string }[]; rows: { cells: Record<string, string | number | null | undefined> }[] };

/** The stock report in the person's language. Other reports pass through until they are translated. */
export function localizeStockReport<R extends StockReportShape>(report: R, t: Translate): R {
  if (report.kind !== "stock") return report;
  const STATUS: Record<string, MessageKey> = { "Out of stock": "stock.status.out", "Reorder now": "stock.status.reorder", Low: "stock.status.low", "Needs checking": "stock.status.needsCheck" };
  const HEADINGS: Record<string, MessageKey> = { name: "common.product", sku: "report.stock.sku", status: "common.status", qty: "report.stock.inStock", reorder: "report.stock.reorder", unit: "common.unit" };
  return {
    ...report,
    title: t("report.stock.title"),
    description: t("report.stock.description"),
    columns: report.columns.map((column) => (HEADINGS[column.key] ? { ...column, label: t(HEADINGS[column.key]!) } : column)),
    rows: report.rows.map((row) => {
      const status = STATUS[String(row.cells.status)];
      return { ...row, cells: { ...row.cells, status: status ? t(status) : row.cells.status, unit: unitShort(t, String(row.cells.unit)) } };
    }),
  };
}

type SavedNotification = { kind: string; title: string; body: string };
const SAVE_AGAIN = " · Save again within 10 minutes.";

/**
 * A saved alert in the reader's language. The saved row never changes. Nexora's own sentences are translated with
 * their values kept; whatever someone typed (a customer, a request's target, a decision reason) stays as written.
 */
export function notificationText(item: SavedNotification, t: Translate, language: Language): { title: string; body: string } {
  const title = translateServerMessage(item.title, language);
  if (item.kind === "approval_requested") return { title, body: item.body };
  if (item.kind === "approval_decided") return { title, body: item.body.endsWith(SAVE_AGAIN) ? `${item.body.slice(0, -SAVE_AGAIN.length)} · ${t("notifications.saveAgain")}` : item.body };
  return { title, body: translateServerMessage(item.body, language) };
}

/**
 * A left-out import row's problem. Prefixes and field names are ours, and each message is translated on its own;
 * values from the file, such as a code or a name, stay as written.
 */
export function importProblemLabel(problem: string, language: Language): string {
  const prefix = /^(Skipped|Error): /.exec(problem);
  const rest = prefix ? problem.slice(prefix[0].length) : problem;
  const single = translateServerMessage(rest, language);
  const parts = (single !== rest ? [rest] : rest.split("; ")).map((part) => {
    const whole = translateServerMessage(part, language);
    if (whole !== part) return whole;
    const at = part.indexOf(": ");
    return at === -1 ? part : `${translateServerMessage(part.slice(0, at), language)}: ${translateServerMessage(part.slice(at + 2), language)}`;
  });
  const word = prefix ? `${translateServerMessage(prefix[1]!, language)}: ` : "";
  return `${word}${parts.join("; ")}`;
}

/** A date with its time in India, such as "26 Oct, 3:11 pm". */
export function timeLabel(date: Date, language: Language): string {
  return new Intl.DateTimeFormat(LANGUAGE_LOCALES[language].dates, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(date);
}

/** A date range as a heading. A custom range is its own dates, in any language. */
export function rangeLabel(t: Translate, range: Pick<ReportRange, "preset" | "label">): string {
  if (range.preset === "custom") return range.label;
  return t(range.preset === "7d" ? "range.last7" : `range.${range.preset}`);
}

/** The same label inside a sentence: "Billed sales · today". Scripts without capitals are unchanged. */
export function rangeInSentence(t: Translate, range: Pick<ReportRange, "preset" | "label">): string {
  return rangeLabel(t, range).toLowerCase();
}

export { expenseLabel };

const METHOD_KEYS: Record<string, MessageKey> = { cash: "common.cash", upi: "common.upi", card: "common.card", bank: "common.bank", cheque: "common.cheque" };

/** A stored payment method for display. The stored identifier never changes; an unknown one is shown as saved. */
export function paymentMethodLabel(t: Translate, code: string): string {
  const key = METHOD_KEYS[code.toLowerCase()];
  return key ? t(key) : code;
}

/** A saved drawer difference reads "<reason>" or "<reason>: <note>". The reason is ours; the note stays as typed. */
export function differenceReasonLabel(t: Translate, saved: string): string {
  for (const reason of DIFFERENCE_REASONS) {
    if (saved === reason.label) return t(`cashbook.reason.${reason.key}`);
    if (saved.startsWith(`${reason.label}: `)) return `${t(`cashbook.reason.${reason.key}`)}${saved.slice(reason.label.length)}`;
  }
  return saved;
}

const REPORT_COLUMNS: Record<string, MessageKey> = {
  Date: "common.date", Bill: "reports.col.bill", Customer: "common.customer.label", Status: "common.status", Billed: "reports.col.billed", "Paid at counter": "reports.col.paidAtCounter", "On credit": "reports.col.onCredit",
  Type: "common.type", Party: "reports.col.party", Method: "reports.col.method", "Receipt / reference": "reports.col.receiptRef", Amount: "common.amount", "Credit note": "reports.col.creditNote", "Settled by": "reports.col.settledBy",
  Category: "common.category", Note: "cashbook.note", "Paid by": "cashbook.paidBy", Product: "common.product", "Quantity sold": "reports.col.quantitySold", Unit: "common.unit", Bills: "reports.col.bills", "Billed value": "reports.col.billedValue",
  Phone: "common.phone", Balance: "reports.col.balance", Overdue: "reports.col.overdue", "Oldest unpaid (days)": "reports.col.oldest", Supplier: "reports.col.supplier", "You owe": "reports.col.youOwe", "Next due": "reports.col.nextDue",
};
const REPORT_STATUS: Record<string, MessageKey> = { Issued: "reports.status.issued", Cancelled: "status.cancelled", Recorded: "reports.status.recorded", Voided: "reports.status.voided" };
const PAYMENT_KINDS: Record<string, MessageKey> = { "Paid on bill": "reports.kind.bill", "Old dues received": "reports.kind.collection", "Receipt reversed": "reports.kind.receiptReversed", "Refund to customer": "reports.kind.refund", "Paid to supplier": "reports.kind.supplierPaid", "Supplier payment reversed": "reports.kind.supplierReturned" };
const REVERSED_SUFFIX = " (reversed)";

function paymentKindLabel(t: Translate, saved: string): string {
  const reversed = saved.endsWith(REVERSED_SUFFIX);
  const kind = PAYMENT_KINDS[reversed ? saved.slice(0, -REVERSED_SUFFIX.length) : saved];
  if (!kind) return saved;
  return reversed ? t("reports.kind.reversed", { kind: t(kind) }) : t(kind);
}

function settlementLabel(t: Translate, saved: string): string {
  if (saved === "Customer account") return t("reports.settlement.account");
  return saved.startsWith("Refund · ") ? t("reports.settlement.refund", { method: paymentMethodLabel(t, saved.slice(9)) }) : saved;
}

type ReportCells = Record<string, string | number | null | undefined>;

/**
 * Any report in the person's language: title, headings and Nexora's own words. Amounts, dates, numbers,
 * references, notes and names somebody entered stay exactly as the report produced them.
 */
export function localizeReport<R extends StockReportShape>(report: R, t: Translate, language: Language): R {
  if (report.kind === "stock") return localizeStockReport(report, t);
  const prefix = `reports.${report.kind}`;
  const word = (cells: ReportCells, name: string, change: (value: string) => string) => (typeof cells[name] === "string" ? { [name]: change(cells[name]) } : {});
  return {
    ...report,
    title: t(`${prefix}.title` as MessageKey),
    description: t(`${prefix}.description` as MessageKey),
    columns: report.columns.map((column) => (REPORT_COLUMNS[column.label] ? { ...column, label: t(REPORT_COLUMNS[column.label]!) } : column)),
    rows: report.rows.map((row) => {
      const cells = row.cells;
      return {
        ...row,
        cells: {
          ...cells,
          ...word(cells, "status", (value) => (REPORT_STATUS[value] ? t(REPORT_STATUS[value]!) : value)),
          ...word(cells, "kind", (value) => paymentKindLabel(t, value)),
          ...word(cells, "method", (value) => paymentMethodLabel(t, value)),
          ...word(cells, "settlement", (value) => settlementLabel(t, value)),
          ...word(cells, "category", (value) => {
            const category = EXPENSE_CATEGORIES.find((entry) => entry.label === value);
            return category ? expenseLabel(t, category) : value;
          }),
          ...word(cells, "customer", (value) => systemName(value, language)),
          ...word(cells, "party", (value) => systemName(value, language)),
          ...(report.kind === "products" ? { ...word(cells, "name", (value) => systemName(value, language)), ...word(cells, "unit", (value) => unitShort(t, value)) } : {}),
        },
      };
    }),
  };
}

/**
 * Recent activity reads "<method or bill number> · <name>". The method and the no-name fallbacks are ours to
 * translate; a name somebody entered is kept as written, even if it happens to be a dictionary word.
 */
export function activityLabel(label: string, language: Language): string {
  const at = label.indexOf(" · ");
  if (at === -1) return label;
  const name = label.slice(at + 3);
  return `${translateServerMessage(label.slice(0, at), language)} · ${systemName(name, language)}`;
}
