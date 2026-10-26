import { sql } from "drizzle-orm";
import type { Transaction } from "@/server/db";
import { ConflictError } from "@/server/errors";

/**
 * The day lock, first in the lock order (CLAUDE.md: day lock → document → stock → balances → numbers).
 *
 * Every write that changes a day's money (bills, cancellations, returns, receipts, supplier payments,
 * expenses, cash movements) takes a SHARED advisory lock on (shop, business date) and then checks the
 * day is not closed. Closing takes the EXCLUSIVE lock, so it waits for writes already in progress and
 * no new write can slip in while the snapshot is taken. Spec §7: after closing, that day's bills,
 * payments and expenses can't be added, edited or deleted until the owner reopens it.
 *
 * Kept in src/server (not the cashbook module) so sales and purchasing can call it without importing
 * the cashbook, which itself reads their totals. It reads the cashbook's day_closings table only.
 */
const keys = (shopId: string, businessDate: string) => sql`hashtext(${shopId}), hashtext(${businessDate})`;

export async function lockDayForWrite(tx: Transaction, shopId: string, businessDate: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${keys(shopId, businessDate)})`);
  const result = await tx.execute<{ status: string }>(sql`select status from day_closings where shop_id = ${shopId}::uuid and business_date = ${businessDate}::date`);
  if (result.rows[0]?.status === "closed") {
    throw new ConflictError("DAY_CLOSED", "This day is closed. The owner can reopen it to make changes; otherwise record it on today's date.");
  }
}

/** Exclusive version, for closing and reopening a day. */
export async function lockDayExclusive(tx: Transaction, shopId: string, businessDate: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${keys(shopId, businessDate)})`);
}
