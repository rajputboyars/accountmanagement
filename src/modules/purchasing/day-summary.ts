import { and, eq, sql } from "drizzle-orm";
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
