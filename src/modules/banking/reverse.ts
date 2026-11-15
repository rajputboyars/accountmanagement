import { sql } from "drizzle-orm";
import { reverseJournal, type PostingContext } from "@/modules/accounting";
import type { Transaction } from "@/server/db";
import { NotFoundError } from "@/server/errors";

/** Reverses a journal on the date it was posted, so a decision taken back leaves the books as if it never happened on that date. */
export async function reverseJournalById(tx: Transaction, ctx: PostingContext, journalId: string, memo: string) {
  const result = await tx.execute<{ entry_date: string }>(sql`select entry_date::text as entry_date from journals where id = ${journalId}::uuid and shop_id = ${ctx.shopId}::uuid`);
  const date = result.rows[0]?.entry_date;
  if (!date) throw new NotFoundError("Journal not found.");
  return reverseJournal(tx, ctx, { journalId, entryDate: date, memo });
}
