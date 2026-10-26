import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database, Transaction } from "@/server/db";
import { payments, PAYMENT_METHODS } from "./schema";

/**
 * Public API of the payments module. A payment row records money that actually moved; amounts are
 * never edited. A refund is a new "out" row, and the original is marked reversed and linked to it.
 */

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export type CounterPayment = {
  shopId: string;
  fy: string;
  customerId: string | null;
  invoiceId: string;
  method: PaymentMethod;
  amountPaise: number;
  businessDate: string;
  recordedBy: string;
};

/** Money received at the counter for a bill: one row per method (split payments stay separate). */
export async function recordCounterPayment(tx: Transaction, payment: CounterPayment): Promise<string> {
  const id = randomUUID();
  await tx.insert(payments).values({
    id,
    shopId: payment.shopId,
    fy: payment.fy,
    direction: "in",
    partyType: payment.customerId ? "customer" : "none",
    partyId: payment.customerId,
    invoiceId: payment.invoiceId,
    method: payment.method,
    amountPaise: payment.amountPaise,
    businessDate: payment.businessDate,
    recordedBy: payment.recordedBy,
  });
  return id;
}

export type InvoicePayment = { id: string; method: PaymentMethod; amountPaise: number; direction: "in" | "out"; status: "recorded" | "reversed"; createdAt: Date };

export async function paymentsForInvoice(db: Database | Transaction, shopId: string, invoiceId: string): Promise<InvoicePayment[]> {
  return db
    .select({ id: payments.id, method: payments.method, amountPaise: payments.amountPaise, direction: payments.direction, status: payments.status, createdAt: payments.createdAt })
    .from(payments)
    .where(and(eq(payments.shopId, shopId), eq(payments.invoiceId, invoiceId)))
    .orderBy(payments.createdAt);
}

/**
 * Refunds every recorded "in" payment of an invoice by the same method: a new "out" row each, and
 * the original marked reversed. Returns the refunds so the caller can write ledger entries.
 */
export async function refundInvoicePayments(
  tx: Transaction,
  invoice: { shopId: string; fy: string; invoiceId: string; customerId: string | null; businessDate: string; recordedBy: string },
): Promise<{ id: string; method: PaymentMethod; amountPaise: number }[]> {
  const originals = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.shopId, invoice.shopId), eq(payments.invoiceId, invoice.invoiceId), eq(payments.direction, "in"), eq(payments.status, "recorded")))
    .for("update");
  const refunds: { id: string; method: PaymentMethod; amountPaise: number }[] = [];
  for (const original of originals) {
    const id = randomUUID();
    await tx.insert(payments).values({
      id,
      shopId: invoice.shopId,
      fy: invoice.fy,
      direction: "out",
      partyType: invoice.customerId ? "customer" : "none",
      partyId: invoice.customerId,
      invoiceId: invoice.invoiceId,
      method: original.method,
      amountPaise: original.amountPaise,
      businessDate: invoice.businessDate,
      recordedBy: invoice.recordedBy,
    });
    await tx.update(payments).set({ status: "reversed", reversedByPaymentId: id }).where(eq(payments.id, original.id));
    refunds.push({ id, method: original.method, amountPaise: original.amountPaise });
  }
  return refunds;
}

/** Money paid back to a customer for a credit note (an "out" row linked to the note and its invoice). */
export async function recordCreditNoteRefund(
  tx: Transaction,
  refund: { shopId: string; fy: string; customerId: string | null; invoiceId: string; creditNoteId: string; method: PaymentMethod; amountPaise: number; businessDate: string; recordedBy: string },
): Promise<string> {
  const id = randomUUID();
  await tx.insert(payments).values({
    id,
    shopId: refund.shopId,
    fy: refund.fy,
    direction: "out",
    partyType: refund.customerId ? "customer" : "none",
    partyId: refund.customerId,
    invoiceId: refund.invoiceId,
    creditNoteId: refund.creditNoteId,
    method: refund.method,
    amountPaise: refund.amountPaise,
    businessDate: refund.businessDate,
    recordedBy: refund.recordedBy,
  });
  return id;
}

export type SupplierPaymentRow = { id: string; method: PaymentMethod; amountPaise: number; reference: string | null; businessDate: string; direction: "in" | "out"; status: "recorded" | "reversed"; createdAt: Date };

/** Money paid to a supplier ("out", party supplier). */
export async function recordSupplierPayment(
  tx: Transaction,
  payment: { shopId: string; fy: string; supplierId: string; method: PaymentMethod; amountPaise: number; reference: string | null; businessDate: string; recordedBy: string },
): Promise<string> {
  const id = randomUUID();
  await tx.insert(payments).values({
    id,
    shopId: payment.shopId,
    fy: payment.fy,
    direction: "out",
    partyType: "supplier",
    partyId: payment.supplierId,
    method: payment.method,
    amountPaise: payment.amountPaise,
    reference: payment.reference,
    businessDate: payment.businessDate,
    recordedBy: payment.recordedBy,
  });
  return id;
}

/**
 * Reverses a supplier payment entered by mistake: a new "in" row for the same amount and method,
 * with the original marked reversed and linked to it. Returns the original (locked) and the reversal id.
 */
export async function reverseSupplierPaymentRow(tx: Transaction, shopId: string, paymentId: string, info: { fy: string; businessDate: string; recordedBy: string }) {
  if (!/^[0-9a-f-]{36}$/i.test(paymentId)) return null;
  const [original] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.shopId, shopId), eq(payments.id, paymentId), eq(payments.partyType, "supplier"), eq(payments.direction, "out")))
    .limit(1)
    .for("update");
  if (!original) return null;
  if (original.status === "reversed") return { original, reversalId: null };
  const reversalId = randomUUID();
  await tx.insert(payments).values({
    id: reversalId,
    shopId,
    fy: info.fy,
    direction: "in",
    partyType: "supplier",
    partyId: original.partyId,
    method: original.method,
    amountPaise: original.amountPaise,
    businessDate: info.businessDate,
    recordedBy: info.recordedBy,
  });
  await tx.update(payments).set({ status: "reversed", reversedByPaymentId: reversalId }).where(eq(payments.id, original.id));
  return { original, reversalId };
}

export async function supplierPayments(db: Database | Transaction, shopId: string, supplierId: string): Promise<SupplierPaymentRow[]> {
  return db
    .select({ id: payments.id, method: payments.method, amountPaise: payments.amountPaise, reference: payments.reference, businessDate: payments.businessDate, direction: payments.direction, status: payments.status, createdAt: payments.createdAt })
    .from(payments)
    .where(and(eq(payments.shopId, shopId), eq(payments.partyType, "supplier"), eq(payments.partyId, supplierId)))
    .orderBy(payments.createdAt);
}

// ── Day totals for the cashbook ─────────────────────────────────────────────

/**
 * What a payment row is, for the cashbook. Every row is money that moved, so originals and their
 * reversals are both counted (they cancel out): a cancelled bill's cash and its refund net to zero.
 *   bill               money in on a bill at the counter
 *   collection         money in from a customer not tied to a bill (old dues)
 *   refund             money paid back to a customer (cancellation or credit note)
 *   supplier_paid      money paid to a supplier
 *   supplier_returned  a supplier payment reversed
 */
export const PAYMENT_CATEGORY_SQL = sql<string>`case
  when ${payments.partyType} = 'supplier' and ${payments.direction} = 'out' then 'supplier_paid'
  when ${payments.partyType} = 'supplier' and ${payments.direction} = 'in' then 'supplier_returned'
  when ${payments.direction} = 'out' then 'refund'
  when ${payments.invoiceId} is not null then 'bill'
  else 'collection' end`;

export type PaymentCategory = "bill" | "collection" | "refund" | "supplier_paid" | "supplier_returned";

/** Sums per method and category for business dates in [fromDate, toDate] (null from = since the start). */
export async function paymentTotals(db: Database | Transaction, shopId: string, fromDate: string | null, toDate: string) {
  const rows = await db
    .select({ method: payments.method, category: PAYMENT_CATEGORY_SQL, total: sql<string>`sum(${payments.amountPaise})::text` })
    .from(payments)
    .where(and(eq(payments.shopId, shopId), fromDate ? sql`${payments.businessDate} >= ${fromDate}` : undefined, sql`${payments.businessDate} <= ${toDate}`))
    .groupBy(payments.method, PAYMENT_CATEGORY_SQL);
  return rows.map((row) => ({ method: row.method, category: row.category as PaymentCategory, totalPaise: Number(row.total) }));
}

export type DayPayment = { id: string; method: PaymentMethod; direction: "in" | "out"; category: PaymentCategory; amountPaise: number; partyType: string; partyId: string | null; invoiceId: string | null; creditNoteId: string | null; reference: string | null; status: string; createdAt: Date };

export async function paymentsOnDay(db: Database | Transaction, shopId: string, businessDate: string): Promise<DayPayment[]> {
  const rows = await db
    .select({ id: payments.id, method: payments.method, direction: payments.direction, category: PAYMENT_CATEGORY_SQL, amountPaise: payments.amountPaise, partyType: payments.partyType, partyId: payments.partyId, invoiceId: payments.invoiceId, creditNoteId: payments.creditNoteId, reference: payments.reference, status: payments.status, createdAt: payments.createdAt })
    .from(payments)
    .where(and(eq(payments.shopId, shopId), eq(payments.businessDate, businessDate)))
    .orderBy(payments.createdAt);
  return rows.map((row) => ({ ...row, category: row.category as PaymentCategory }));
}

export { PAYMENTS_RECORD, PAYMENTS_REVERSE, recordCustomerReceipt, reverseCustomerReceipt, type RecordedReceipt } from "./receipts";

/** Payment details for labelling ledger lines (receipt number, method, links). Ids of other shops are ignored. */
export async function paymentDetails(db: Database | Transaction, shopId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, { receiptNumber: string | null; method: PaymentMethod; reference: string | null; direction: "in" | "out"; status: string; invoiceId: string | null; creditNoteId: string | null }>();
  const rows = await db
    .select({ id: payments.id, receiptNumber: payments.receiptNumber, method: payments.method, reference: payments.reference, direction: payments.direction, status: payments.status, invoiceId: payments.invoiceId, creditNoteId: payments.creditNoteId })
    .from(payments)
    .where(and(eq(payments.shopId, shopId), inArray(payments.id, ids)));
  return new Map(rows.map(({ id, ...row }) => [id, row]));
}

/** A customer's receipts (money in not tied to a bill), newest first. */
export async function customerReceipts(db: Database | Transaction, shopId: string, customerId: string) {
  return db
    .select({ id: payments.id, receiptNumber: payments.receiptNumber, method: payments.method, amountPaise: payments.amountPaise, reference: payments.reference, businessDate: payments.businessDate, status: payments.status, createdAt: payments.createdAt })
    .from(payments)
    .where(and(eq(payments.shopId, shopId), eq(payments.partyType, "customer"), eq(payments.partyId, customerId), sql`${payments.receiptNumber} is not null`))
    .orderBy(sql`${payments.createdAt} desc`);
}

export { collectionsByDay, PAYMENT_REPORT_KIND_SQL, paymentKindTotals, paymentsInRange, recentPayments, type PaymentReportKind } from "./reports";
