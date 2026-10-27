import { recordAudit } from "@/modules/audit";
import { getCurrentShop } from "@/modules/settings";
import { hasPermission, requirePermission, type SessionContext } from "@/modules/identity";
import { partyStatement, partyStatements, type StatementLine } from "@/modules/ledger";
import { findCustomer, findSupplier, listShopCustomers, listShopSuppliers } from "@/modules/parties";
import { customerReceipts, paymentDetails, PAYMENTS_RECORD, PAYMENTS_REVERSE } from "@/modules/payments";
import { receiptNumbersFor } from "@/modules/purchasing";
import { documentNumbers } from "@/modules/sales";
import { getDb, withTransaction } from "@/server/db";
import { ConflictError } from "@/server/errors";
import { ageOpenItems, dueTone, type AgeingEntry } from "@/shared/ageing";
import { indiaDate } from "@/shared/financial-year";
import { formatPaise } from "@/shared/money";
import { getReminderProvider } from "./reminder-provider";

/**
 * Receivables and payables, party statements and reminders. Read-only views over the ledger: every
 * balance is SUM(ledger_entries); "which bills are open" and ageing are worked out oldest-first
 * (src/shared/ageing.ts) and never stored. Receivables, payables, cash and profit stay separate.
 */

export const CUSTOMERS_VIEW = "customers.view" as const;
export const SUPPLIERS_VIEW = "purchases.view" as const;
/** Spec §4 assumption: a customer bill is overdue after 30 days. */
export const CUSTOMER_TERMS_DAYS = 30;

const db = () => getDb();

/**
 * Entries for ageing. A cancelled bill and its cancellation credit are dropped as a pair, so the
 * cancellation doesn't pay off an older bill. `owedSign` = 1 for customers (debit = owed),
 * −1 for suppliers (credit = owed by the shop).
 */
function ageingEntries(lines: StatementLine[], owedSign: 1 | -1, labels: Map<string, string>): AgeingEntry[] {
  const cancelled = new Set(lines.filter((line) => line.kind === "cancellation").map((line) => line.sourceId));
  return lines
    .filter((line) => !cancelled.has(line.sourceId) || (line.kind !== "cancellation" && line.kind !== "invoice" && line.kind !== "purchase"))
    .map((line) => ({
      id: String(line.id),
      date: line.entryDate,
      debitPaise: owedSign === 1 ? line.debitPaise : line.creditPaise,
      creditPaise: owedSign === 1 ? line.creditPaise : line.debitPaise,
      label: labels.get(line.sourceId) ?? KIND_LABEL[line.kind] ?? line.kind,
    }));
}

const KIND_LABEL: Record<string, string> = { opening: "Opening balance", invoice: "Bill", payment: "Payment", credit_note: "Credit note", cancellation: "Cancelled", purchase: "Goods received", correction: "Correction" };

async function labelsFor(shopId: string, lines: StatementLine[]) {
  const by = (type: string) => [...new Set(lines.filter((line) => line.sourceType === type).map((line) => line.sourceId))];
  const [docs, grns, pays] = await Promise.all([
    documentNumbers(shopId, { invoiceIds: by("invoice"), creditNoteIds: by("credit_note") }),
    receiptNumbersFor(shopId, by("goods_receipt")),
    paymentDetails(db(), shopId, by("payment")),
  ]);
  const labels = new Map<string, string>([...docs, ...grns]);
  const links = new Map<string, string>();
  for (const line of lines) {
    if (line.sourceType === "invoice") links.set(line.sourceId, `/billing/invoices/${line.sourceId}`);
    if (line.sourceType === "credit_note") links.set(line.sourceId, `/billing/returns/${line.sourceId}`);
    if (line.sourceType === "goods_receipt") links.set(line.sourceId, `/purchases/receipts/${line.sourceId}`);
  }
  for (const [id, pay] of pays) {
    const method = pay.method.toUpperCase();
    labels.set(id, pay.receiptNumber ? `${pay.receiptNumber} · ${method}` : `${pay.direction === "out" ? "Refund / reversal" : "Paid"} · ${method}${pay.reference ? ` ${pay.reference}` : ""}`);
    if (pay.invoiceId) links.set(id, `/billing/invoices/${pay.invoiceId}`);
    if (pay.creditNoteId) links.set(id, `/billing/returns/${pay.creditNoteId}`);
  }
  return { labels, links };
}

function describe(line: StatementLine, labels: Map<string, string>) {
  const ref = labels.get(line.sourceId);
  const what = line.kind === "cancellation" ? `Cancelled ${ref ?? ""}`.trim() : line.kind === "opening" ? "Opening balance" : ref ?? KIND_LABEL[line.kind] ?? line.kind;
  return what;
}

// ── Customers ────────────────────────────────────────────────────────────────

export async function listReceivables(session: SessionContext, asOf = indiaDate()) {
  await requirePermission(session, CUSTOMERS_VIEW);
  const [customers, statements] = await Promise.all([listShopCustomers(session.shopId, { includeInactive: true }), partyStatements(session.shopId, "customer")]);
  const rows = customers.map((customer) => {
    const lines = statements.get(customer.id) ?? [];
    const balancePaise = lines.at(-1)?.balancePaise ?? 0;
    const ageing = ageOpenItems(ageingEntries(lines, 1, new Map()), asOf, CUSTOMER_TERMS_DAYS);
    const oldest = ageing.open[0]?.ageDays ?? null;
    return { ...customer, balancePaise, overduePaise: ageing.overduePaise, oldestDueDays: oldest, tone: dueTone(oldest, balancePaise), buckets: ageing.buckets };
  });
  rows.sort((a, b) => b.balancePaise - a.balancePaise);
  const sum = (pick: (row: (typeof rows)[number]) => number) => rows.reduce((total, row) => total + pick(row), 0);
  return {
    rows,
    totals: {
      receivablePaise: sum((row) => Math.max(row.balancePaise, 0)),
      advancesPaise: sum((row) => Math.max(-row.balancePaise, 0)),
      overduePaise: sum((row) => row.overduePaise),
      buckets: {
        notDuePaise: sum((row) => row.buckets.notDuePaise),
        days1to30Paise: sum((row) => row.buckets.days1to30Paise),
        days31to60Paise: sum((row) => row.buckets.days31to60Paise),
        days61to90Paise: sum((row) => row.buckets.days61to90Paise),
        over90Paise: sum((row) => row.buckets.over90Paise),
      },
    },
    asOf,
    canAdd: await hasPermission(session, "customers.edit"),
  };
}

/** A customer's account: statement (optionally from a date, with balance brought forward), open bills, receipts. */
export async function getCustomerAccount(session: SessionContext, customerId: string, options: { from?: string; to?: string } = {}) {
  await requirePermission(session, CUSTOMERS_VIEW);
  const customer = await findCustomer(session.shopId, customerId);
  if (customer.type === "walkin") throw new ConflictError("WALKIN_NO_ACCOUNT", "The walk-in customer has no account.");
  const asOf = indiaDate();
  const lines = await partyStatement(session.shopId, "customer", customer.id);
  const { labels, links } = await labelsFor(session.shopId, lines);
  const from = options.from && /^\d{4}-\d{2}-\d{2}$/.test(options.from) ? options.from : null;
  const to = options.to && /^\d{4}-\d{2}-\d{2}$/.test(options.to) ? options.to : null;
  const before = from ? lines.filter((line) => line.entryDate < from) : [];
  const shown = lines.filter((line) => (!from || line.entryDate >= from) && (!to || line.entryDate <= to));
  const ageing = ageOpenItems(ageingEntries(lines, 1, labels), asOf, CUSTOMER_TERMS_DAYS);
  const [receipts, canRecord, canReverse, canEdit, shop] = await Promise.all([
    customerReceipts(db(), session.shopId, customer.id),
    hasPermission(session, PAYMENTS_RECORD),
    hasPermission(session, PAYMENTS_REVERSE),
    hasPermission(session, "customers.edit"),
    getCurrentShop(session),
  ]);
  const balancePaise = lines.at(-1)?.balancePaise ?? 0;
  return {
    customer,
    shop,
    asOf,
    from,
    to,
    broughtForwardPaise: before.at(-1)?.balancePaise ?? 0,
    statement: shown.map((line) => ({ ...line, description: describe(line, labels), href: links.get(line.sourceId) ?? null })),
    balancePaise,
    availableCreditPaise: Math.max(customer.creditLimitPaise - balancePaise, 0),
    ageing,
    tone: dueTone(ageing.open[0]?.ageDays ?? null, balancePaise),
    receipts,
    canRecord,
    canReverse,
    canEdit,
  };
}

// ── Suppliers ────────────────────────────────────────────────────────────────

export async function listPayables(session: SessionContext, asOf = indiaDate()) {
  await requirePermission(session, SUPPLIERS_VIEW);
  const [suppliers, statements] = await Promise.all([listShopSuppliers(session.shopId, { includeInactive: true }), partyStatements(session.shopId, "supplier")]);
  const rows = suppliers.map((supplier) => {
    const lines = statements.get(supplier.id) ?? [];
    const owedPaise = -(lines.at(-1)?.balancePaise ?? 0) || 0;
    const ageing = ageOpenItems(ageingEntries(lines, -1, new Map()), asOf, supplier.paymentTermsDays);
    return { id: supplier.id, name: supplier.name, owedPaise, overduePaise: ageing.overduePaise, nextDue: ageing.open.find((item) => item.daysPastDue === 0)?.dueDate ?? null, buckets: ageing.buckets };
  });
  return {
    rows,
    totals: { payablePaise: rows.reduce((sum, row) => sum + Math.max(row.owedPaise, 0), 0), overduePaise: rows.reduce((sum, row) => sum + row.overduePaise, 0) },
  };
}

/** A supplier's statement for printing, with bills still unpaid (oldest-first) and their due dates. */
export async function getSupplierStatement(session: SessionContext, supplierId: string) {
  await requirePermission(session, SUPPLIERS_VIEW);
  const supplier = await findSupplier(session.shopId, supplierId);
  const lines = await partyStatement(session.shopId, "supplier", supplier.id);
  const { labels, links } = await labelsFor(session.shopId, lines);
  const ageing = ageOpenItems(ageingEntries(lines, -1, labels), indiaDate(), supplier.paymentTermsDays);
  return {
    supplier,
    shop: await getCurrentShop(session),
    asOf: indiaDate(),
    statement: lines.map((line) => ({ ...line, owedAfterPaise: -line.balancePaise || 0, description: describe(line, labels), href: links.get(line.sourceId) ?? null })),
    owedPaise: -(lines.at(-1)?.balancePaise ?? 0) || 0,
    ageing,
  };
}

// ── Reminders ────────────────────────────────────────────────────────────────

/**
 * A payment reminder for ONE customer, built only from that customer's own account (no other
 * party's data). Requires the customer's WhatsApp consent and a phone number. If a WhatsApp
 * provider is configured it can send; otherwise the result is text to copy or share by hand, and
 * nothing claims it was delivered.
 */
export async function prepareReminder(session: SessionContext, customerId: string) {
  await requirePermission(session, PAYMENTS_RECORD);
  const account = await getCustomerAccount(session, customerId);
  const { customer, shop } = account;
  if (account.balancePaise <= 0) throw new ConflictError("NOTHING_DUE", `${customer.name} has nothing to pay.`);
  if (!customer.whatsappConsent) throw new ConflictError("NO_CONSENT", `${customer.name} hasn't agreed to WhatsApp reminders. Turn it on in their details only if they agreed.`);
  if (!customer.phone) throw new ConflictError("NO_PHONE", `${customer.name} has no phone number.`);
  const oldest = account.ageing.open[0];
  const text = [
    `Namaste ${customer.name},`,
    `Your balance with ${shop.name} is ${formatPaise(account.balancePaise, { withPaise: true })} as of ${account.asOf}.`,
    oldest ? `The oldest unpaid bill is ${oldest.label} of ${oldest.date} (${formatPaise(oldest.remainingPaise, { withPaise: true })} due).` : null,
    "Please pay at your convenience. Thank you.",
  ]
    .filter(Boolean)
    .join("\n");
  const provider = getReminderProvider();
  return { customerId: customer.id, phone: customer.phone, text, shareUrl: `https://wa.me/91${customer.phone}?text=${encodeURIComponent(text)}`, providerConfigured: provider !== null };
}

/**
 * Records that a reminder was sent through the provider, or shared by hand (copy/WhatsApp link).
 * "shared" only means the user opened or copied it; delivery is not confirmed.
 */
export async function logReminder(session: SessionContext, customerId: string, channel: "provider" | "shared") {
  if (channel === "provider") {
    // Queued in the WhatsApp outbox (consent re-checked, one per day); delivery is tracked there.
    const { queueDuesReminder } = await import("./whatsapp");
    const queued = await queueDuesReminder(session, customerId);
    return { delivery: "queued" as const, duplicate: queued.duplicate };
  }
  const reminder = await prepareReminder(session, customerId);
  await withTransaction((tx) =>
    recordAudit(tx, { shopId: session.shopId, userId: session.userId, role: session.role }, { action: "reporting.reminder_shared_manually", entityType: "customer", entityId: customerId, after: { channel, delivery: "shared_manually", textLength: reminder.text.length } }),
  );
  return { delivery: "shared_manually" as const, duplicate: false };
}
