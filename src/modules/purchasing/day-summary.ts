import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, type Database, type Transaction } from "@/server/db";
import { goodsReceipts } from "./schema";

/** Goods received on one business day (not cancelled), for the cashbook. No permission check. */
export async function purchasesDaySummary(shopId: string, businessDate: string, db: Database | Transaction = getDb()) {
  const receipts = await db
    .select({ id: goodsReceipts.id, number: goodsReceipts.number, supplierId: goodsReceipts.supplierId, totalPaise: goodsReceipts.totalPaise, createdAt: goodsReceipts.createdAt })
    .from(goodsReceipts)
    .where(and(eq(goodsReceipts.shopId, shopId), eq(goodsReceipts.receivedDate, businessDate), sql`${goodsReceipts.status} <> 'cancelled'`));
  return { purchasesPaise: receipts.reduce((sum, receipt) => sum + receipt.totalPaise, 0), receipts };
}

/** Goods received (not cancelled) in a range of dates: what the shop now owes suppliers for, not cash paid. */
export async function purchasesRangeSummary(shopId: string, from: string, to: string, db: Database | Transaction = getDb()) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${goodsReceipts.totalPaise}), 0)::text` })
    .from(goodsReceipts)
    .where(and(eq(goodsReceipts.shopId, shopId), sql`${goodsReceipts.receivedDate} >= ${from}`, sql`${goodsReceipts.receivedDate} <= ${to}`, sql`${goodsReceipts.status} <> 'cancelled'`));
  return { receiptCount: row?.count ?? 0, receivedPaise: Number(row?.total ?? 0) };
}

/** Goods receipt numbers for labelling supplier ledger lines. Ids of other shops are ignored. */
export async function receiptNumbersFor(shopId: string, ids: string[], db: Database | Transaction = getDb()) {
  if (ids.length === 0) return new Map<string, string>();
  const rows = await db.select({ id: goodsReceipts.id, number: goodsReceipts.number }).from(goodsReceipts).where(and(eq(goodsReceipts.shopId, shopId), inArray(goodsReceipts.id, ids)));
  return new Map(rows.map((row) => [row.id, row.number]));
}
