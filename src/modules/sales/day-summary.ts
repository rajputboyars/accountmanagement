import { and, eq, sql } from "drizzle-orm";
import { getDb, type Database, type Transaction } from "@/server/db";
import { creditNotes, invoices } from "./schema";

/**
 * One business day of sales for the cashbook and closing snapshot. No permission check: the caller
 * has done it. Sales are invoice totals with GST (spec §6), cancelled bills left out; credit given is
 * the unpaid part of those bills; credit notes are listed separately. None of this is cash.
 */
export type SalesDaySummary = {
  billCount: number;
  salesPaise: number;
  creditGivenPaise: number;
  cancelledCount: number;
  creditNotesPaise: number;
  creditBills: { id: string; number: string; customerId: string; totalPaise: number; paidNowPaise: number; createdAt: Date }[];
  creditNoteList: { id: string; number: string; totalPaise: number; settlement: string; createdAt: Date }[];
};

export async function salesDaySummary(shopId: string, businessDate: string, db: Database | Transaction = getDb()): Promise<SalesDaySummary> {
  const [totals] = await db
    .select({
      billCount: sql<number>`count(*) filter (where ${invoices.status} = 'issued')::int`,
      sales: sql<string>`coalesce(sum(${invoices.totalPaise}) filter (where ${invoices.status} = 'issued'), 0)::text`,
      credit: sql<string>`coalesce(sum(${invoices.totalPaise} - ${invoices.paidNowPaise}) filter (where ${invoices.status} = 'issued'), 0)::text`,
      cancelled: sql<number>`count(*) filter (where ${invoices.status} = 'cancelled')::int`,
    })
    .from(invoices)
    .where(and(eq(invoices.shopId, shopId), eq(invoices.businessDate, businessDate)));
  const creditBills = await db
    .select({ id: invoices.id, number: invoices.number, customerId: invoices.customerId, totalPaise: invoices.totalPaise, paidNowPaise: invoices.paidNowPaise, createdAt: invoices.createdAt })
    .from(invoices)
    .where(and(eq(invoices.shopId, shopId), eq(invoices.businessDate, businessDate), eq(invoices.status, "issued"), sql`${invoices.paidNowPaise} < ${invoices.totalPaise}`));
  const creditNoteList = await db
    .select({ id: creditNotes.id, number: creditNotes.number, totalPaise: creditNotes.totalPaise, settlement: creditNotes.settlement, createdAt: creditNotes.createdAt })
    .from(creditNotes)
    .where(and(eq(creditNotes.shopId, shopId), eq(creditNotes.businessDate, businessDate)));
  return {
    billCount: totals?.billCount ?? 0,
    salesPaise: Number(totals?.sales ?? 0),
    creditGivenPaise: Number(totals?.credit ?? 0),
    cancelledCount: totals?.cancelled ?? 0,
    creditNotesPaise: creditNoteList.reduce((sum, note) => sum + note.totalPaise, 0),
    creditBills,
    creditNoteList,
  };
}
