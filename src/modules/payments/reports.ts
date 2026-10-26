import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, type Database, type Transaction } from "@/server/db";
import { payments } from "./schema";

/**
 * Payment figures for a range of business dates (reports). Like the cashbook categories, except that a
 * customer receipt reversed by mistake ("out", no bill or credit note) is its own kind, so it is
 * netted off collections instead of being shown as a refund. No permission check: the caller does it.
 */
export const PAYMENT_REPORT_KIND_SQL = sql<string>`case
  when ${payments.partyType} = 'supplier' and ${payments.direction} = 'out' then 'supplier_paid'
  when ${payments.partyType} = 'supplier' and ${payments.direction} = 'in' then 'supplier_returned'
  when ${payments.direction} = 'out' and ${payments.invoiceId} is null and ${payments.creditNoteId} is null then 'receipt_reversed'
  when ${payments.direction} = 'out' then 'refund'
  when ${payments.invoiceId} is not null then 'bill'
  else 'collection' end`;

export type PaymentReportKind = "bill" | "collection" | "receipt_reversed" | "refund" | "supplier_paid" | "supplier_returned";

type Db = Database | Transaction;
const inRange = (from: string, to: string) => and(sql`${payments.businessDate} >= ${from}`, sql`${payments.businessDate} <= ${to}`);

/** Sums per kind and method. */
export async function paymentKindTotals(shopId: string, from: string, to: string, db: Db = getDb()) {
  const rows = await db
    .select({ kind: PAYMENT_REPORT_KIND_SQL, method: payments.method, total: sql<string>`sum(${payments.amountPaise})::text`, count: sql<number>`count(*)::int` })
    .from(payments)
    .where(and(eq(payments.shopId, shopId), inRange(from, to)))
    .groupBy(PAYMENT_REPORT_KIND_SQL, payments.method);
  return rows.map((row) => ({ kind: row.kind as PaymentReportKind, method: row.method, totalPaise: Number(row.total), count: row.count }));
}

/** Money received from customers, net of receipt reversals, per business date. */
export async function collectionsByDay(shopId: string, from: string, to: string, db: Db = getDb()) {
  const signed = sql`case when ${payments.direction} = 'in' then ${payments.amountPaise} else -${payments.amountPaise} end`;
  const rows = await db
    .select({ date: payments.businessDate, total: sql<string>`sum(${signed})::text` })
    .from(payments)
    .where(and(eq(payments.shopId, shopId), sql`${payments.partyType} <> 'supplier'`, inRange(from, to), sql`(${payments.direction} = 'in' or (${payments.invoiceId} is null and ${payments.creditNoteId} is null))`))
    .groupBy(payments.businessDate);
  return rows.map((row) => ({ date: row.date, collectedPaise: Number(row.total) }));
}

/** Rows behind the payment figures, newest first. `limit` + 1 rows tells the caller it was cut. */
export async function paymentsInRange(shopId: string, from: string, to: string, limit: number, db: Db = getDb()) {
  const rows = await db
    .select({ id: payments.id, kind: PAYMENT_REPORT_KIND_SQL, receiptNumber: payments.receiptNumber, partyType: payments.partyType, partyId: payments.partyId, invoiceId: payments.invoiceId, creditNoteId: payments.creditNoteId, method: payments.method, amountPaise: payments.amountPaise, reference: payments.reference, businessDate: payments.businessDate, status: payments.status, createdAt: payments.createdAt })
    .from(payments)
    .where(and(eq(payments.shopId, shopId), inRange(from, to)))
    .orderBy(desc(payments.businessDate), desc(payments.createdAt))
    .limit(limit + 1);
  return rows.map((row) => ({ ...row, kind: row.kind as PaymentReportKind }));
}

export async function recentPayments(shopId: string, limit: number, db: Db = getDb()) {
  const rows = await db
    .select({ id: payments.id, kind: PAYMENT_REPORT_KIND_SQL, partyType: payments.partyType, partyId: payments.partyId, invoiceId: payments.invoiceId, method: payments.method, amountPaise: payments.amountPaise, createdAt: payments.createdAt })
    .from(payments)
    .where(eq(payments.shopId, shopId))
    .orderBy(desc(payments.createdAt))
    .limit(limit);
  return rows.map((row) => ({ ...row, kind: row.kind as PaymentReportKind }));
}
