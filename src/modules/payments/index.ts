import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
