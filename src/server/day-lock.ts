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

/**
 * The one narrow exception to the closed-day rule: settling UPI, card or cheque money against the bank statement.
 * That settlement only moves money between "not yet in the bank" and a bank account (and books the fee the bank kept); it
 * never touches the cash drawer, a drawer count or a day closing, and the statement date is a fact the owner cannot choose.
 * So it may be posted on its original date even when that day is closed. It still takes the shared lock, so it can not run
 * while the day is being closed or reopened, and it reports whether the day was closed so the audit trail can say so.
 * Every other money write keeps using lockDayForWrite and stays blocked on a closed day.
 */
export async function lockDayForBankSettlement(tx: Transaction, shopId: string, businessDate: string): Promise<{ dayClosed: boolean }> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${keys(shopId, businessDate)})`);
  const result = await tx.execute<{ status: string }>(sql`select status from day_closings where shop_id = ${shopId}::uuid and business_date = ${businessDate}::date`);
  return { dayClosed: result.rows[0]?.status === "closed" };
}

/** Exclusive version, for closing and reopening a day. */
export async function lockDayExclusive(tx: Transaction, shopId: string, businessDate: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${keys(shopId, businessDate)})`);
}
