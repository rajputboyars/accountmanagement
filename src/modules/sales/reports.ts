import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, type Database, type Transaction } from "@/server/db";
import { creditNoteLines, creditNotes, invoiceLines, invoices } from "./schema";

/**
 * Sales figures for a range of business dates, aggregated in SQL (reports and dashboard). No permission
 * check: the reporting module does it. Billed sales are issued invoice totals with GST; cancelled bills
 * are counted apart. None of this is cash: collections come from the payments module.
 */

type Db = Database | Transaction;
const inRange = (column: typeof invoices.businessDate | typeof creditNotes.businessDate, from: string, to: string) => and(sql`${column} >= ${from}`, sql`${column} <= ${to}`);
const num = (value: string | null | undefined) => Number(value ?? 0);

export type SalesRangeSummary = {
  billCount: number;
  billedPaise: number;
  taxablePaise: number;
  gstPaise: number;
  paidAtCounterPaise: number;
  creditGivenPaise: number;
  cancelledCount: number;
  cancelledPaise: number;
  creditNoteCount: number;
  creditNotesPaise: number;
  /** Credit notes paid back in cash/UPI/bank versus taken off the customer's account. */
  refundedNotesPaise: number;
  adjustedNotesPaise: number;
};

export async function salesRangeSummary(shopId: string, from: string, to: string, db: Db = getDb()): Promise<SalesRangeSummary> {
  const issued = sql`${invoices.status} = 'issued'`;
  const [bills] = await db
    .select({
      billCount: sql<number>`count(*) filter (where ${issued})::int`,
      billed: sql<string>`coalesce(sum(${invoices.totalPaise}) filter (where ${issued}), 0)::text`,
      taxable: sql<string>`coalesce(sum(${invoices.taxablePaise}) filter (where ${issued}), 0)::text`,
      gst: sql<string>`coalesce(sum(${invoices.cgstPaise} + ${invoices.sgstPaise} + ${invoices.igstPaise}) filter (where ${issued}), 0)::text`,
      paid: sql<string>`coalesce(sum(${invoices.paidNowPaise}) filter (where ${issued}), 0)::text`,
      cancelledCount: sql<number>`count(*) filter (where ${invoices.status} = 'cancelled')::int`,
      cancelled: sql<string>`coalesce(sum(${invoices.totalPaise}) filter (where ${invoices.status} = 'cancelled'), 0)::text`,
    })
    .from(invoices)
    .where(and(eq(invoices.shopId, shopId), inRange(invoices.businessDate, from, to)));
  const [notes] = await db
    .select({
      count: sql<number>`count(*)::int`,
      total: sql<string>`coalesce(sum(${creditNotes.totalPaise}), 0)::text`,
      refunded: sql<string>`coalesce(sum(${creditNotes.totalPaise}) filter (where ${creditNotes.settlement} <> 'ledger'), 0)::text`,
    })
    .from(creditNotes)
    .where(and(eq(creditNotes.shopId, shopId), inRange(creditNotes.businessDate, from, to)));
  const billedPaise = num(bills?.billed);
  const paidAtCounterPaise = num(bills?.paid);
  const creditNotesPaise = num(notes?.total);
  const refundedNotesPaise = num(notes?.refunded);
  return {
    billCount: bills?.billCount ?? 0,
    billedPaise,
    taxablePaise: num(bills?.taxable),
    gstPaise: num(bills?.gst),
    paidAtCounterPaise,
    creditGivenPaise: billedPaise - paidAtCounterPaise,
    cancelledCount: bills?.cancelledCount ?? 0,
    cancelledPaise: num(bills?.cancelled),
    creditNoteCount: notes?.count ?? 0,
    creditNotesPaise,
    refundedNotesPaise,
    adjustedNotesPaise: creditNotesPaise - refundedNotesPaise,
  };
}

/** Billed sales per business date (issued bills only). Days without bills are absent. */
export async function salesByDay(shopId: string, from: string, to: string, db: Db = getDb()) {
  const rows = await db
    .select({ date: invoices.businessDate, total: sql<string>`sum(${invoices.totalPaise})::text`, count: sql<number>`count(*)::int` })
    .from(invoices)
    .where(and(eq(invoices.shopId, shopId), eq(invoices.status, "issued"), inRange(invoices.businessDate, from, to)))
    .groupBy(invoices.businessDate);
  return rows.map((row) => ({ date: row.date, billedPaise: num(row.total), billCount: row.count }));
}

/** Products by billed value (taxable, after bill discount, before returns), issued bills only. */
export async function topSellingProducts(shopId: string, from: string, to: string, limit = 10, db: Db = getDb()) {
  const value = sql<string>`sum(${invoiceLines.taxablePaise})`;
  const rows = await db
    .select({ productId: invoiceLines.productId, baseQty: sql<string>`sum(${invoiceLines.baseQty})::text`, value: sql<string>`${value}::text`, bills: sql<number>`count(distinct ${invoices.id})::int` })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(and(eq(invoices.shopId, shopId), eq(invoices.status, "issued"), inRange(invoices.businessDate, from, to)))
    .groupBy(invoiceLines.productId)
    .orderBy(desc(value), invoiceLines.productId)
    .limit(limit);
  return rows.map((row) => ({ productId: row.productId, baseQty: row.baseQty, valuePaise: num(row.value), billCount: row.bills }));
}

/**
 * Inputs for gross profit (handoff §1.7, C4): taxable value and cost of issued bills in the range, less
 * credit notes in the range (their taxable value, plus back the cost of goods that went back into stock;
 * damaged returns are written off, so their cost is not recovered). Cost is the unit cost copied onto
 * each bill line at sale time × base quantity, half-up per line. Lines without a cost are counted, never
 * guessed; any such line makes the period's profit unreliable.
 */
export type ProfitInputs = { billTaxablePaise: number; billCostPaise: number; noteTaxablePaise: number; noteRestockedCostPaise: number; missingCostLines: number; missingCostProductIds: string[] };

export async function profitInputs(shopId: string, from: string, to: string, db: Db = getDb()): Promise<ProfitInputs> {
  const lineCost = sql`round(${invoiceLines.unitCostPaise} * ${invoiceLines.baseQty})`;
  const [bills] = await db
    .select({
      taxable: sql<string>`coalesce(sum(${invoiceLines.taxablePaise}), 0)::text`,
      cost: sql<string>`coalesce(sum(${lineCost}), 0)::text`,
      missing: sql<number>`count(*) filter (where ${invoiceLines.unitCostPaise} is null)::int`,
    })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(and(eq(invoices.shopId, shopId), eq(invoices.status, "issued"), inRange(invoices.businessDate, from, to)));
  const [notes] = await db
    .select({
      taxable: sql<string>`coalesce(sum(${creditNoteLines.taxablePaise}), 0)::text`,
      restocked: sql<string>`coalesce(sum(round(${invoiceLines.unitCostPaise} * ${creditNoteLines.baseQty})) filter (where ${creditNoteLines.restock}), 0)::text`,
      missing: sql<number>`count(*) filter (where ${invoiceLines.unitCostPaise} is null and ${creditNoteLines.restock})::int`,
    })
    .from(creditNoteLines)
    .innerJoin(creditNotes, eq(creditNotes.id, creditNoteLines.creditNoteId))
    .innerJoin(invoiceLines, eq(invoiceLines.id, creditNoteLines.invoiceLineId))
    .where(and(eq(creditNotes.shopId, shopId), inRange(creditNotes.businessDate, from, to)));
  const missingProducts = await db
    .selectDistinct({ productId: invoiceLines.productId })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(and(eq(invoices.shopId, shopId), eq(invoices.status, "issued"), inRange(invoices.businessDate, from, to), sql`${invoiceLines.unitCostPaise} is null`))
    .limit(50);
  return {
    billTaxablePaise: num(bills?.taxable),
    billCostPaise: num(bills?.cost),
    noteTaxablePaise: num(notes?.taxable),
    noteRestockedCostPaise: num(notes?.restocked),
    missingCostLines: (bills?.missing ?? 0) + (notes?.missing ?? 0),
    missingCostProductIds: missingProducts.map((row) => row.productId),
  };
}

/** Rows behind the sales figures, newest first (drill-down and CSV). `limit` + 1 rows tells the caller it was cut. */
export async function invoicesInRange(shopId: string, from: string, to: string, limit: number, db: Db = getDb()) {
  return db
    .select({ id: invoices.id, number: invoices.number, businessDate: invoices.businessDate, customerId: invoices.customerId, priceList: invoices.priceList, taxablePaise: invoices.taxablePaise, totalPaise: invoices.totalPaise, paidNowPaise: invoices.paidNowPaise, status: invoices.status, costComplete: invoices.costComplete, createdAt: invoices.createdAt })
    .from(invoices)
    .where(and(eq(invoices.shopId, shopId), inRange(invoices.businessDate, from, to)))
    .orderBy(desc(invoices.businessDate), desc(invoices.createdAt))
    .limit(limit + 1);
}

export async function creditNotesInRange(shopId: string, from: string, to: string, limit: number, db: Db = getDb()) {
  return db
    .select({ id: creditNotes.id, number: creditNotes.number, businessDate: creditNotes.businessDate, customerId: creditNotes.customerId, invoiceId: creditNotes.invoiceId, settlement: creditNotes.settlement, totalPaise: creditNotes.totalPaise, createdAt: creditNotes.createdAt })
    .from(creditNotes)
    .where(and(eq(creditNotes.shopId, shopId), inRange(creditNotes.businessDate, from, to)))
    .orderBy(desc(creditNotes.businessDate), desc(creditNotes.createdAt))
    .limit(limit + 1);
}

/** Latest bills for "recent activity". */
export async function recentInvoices(shopId: string, limit: number, db: Db = getDb()) {
  return db
    .select({ id: invoices.id, number: invoices.number, customerId: invoices.customerId, totalPaise: invoices.totalPaise, paidNowPaise: invoices.paidNowPaise, status: invoices.status, createdAt: invoices.createdAt })
    .from(invoices)
    .where(eq(invoices.shopId, shopId))
    .orderBy(desc(invoices.createdAt))
    .limit(limit);
}
