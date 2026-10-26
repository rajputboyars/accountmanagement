import { and, eq, sql } from "drizzle-orm";
import type { Transaction } from "@/server/db";
import { financialYearLabel } from "@/shared/financial-year";
import { numberSeries, shops } from "./schema";
import type { DOCUMENT_SERIES } from "./setup";

export type DocumentSeries = (typeof DOCUMENT_SERIES)[number];

/**
 * Takes the next number of a series inside the caller's transaction, e.g. "ADJ/26-27/00001"
 * (≤ 16 characters, restarting each financial year). The row is locked until the transaction
 * ends, so numbers are gap-free: a rollback gives the number back. Call it last in the lock
 * order (day lock → document → stock_levels → party_balances → number_series).
 */
export async function takeDocumentNumber(tx: Transaction, shopId: string, series: DocumentSeries, now: Date = new Date()): Promise<{ fy: string; number: string }> {
  const [shop] = await tx.select({ fyStartMonth: shops.fyStartMonth }).from(shops).where(eq(shops.id, shopId)).limit(1);
  const fy = financialYearLabel(now, shop?.fyStartMonth ?? 4);
  // A new financial year has no row yet: create it (another transaction may race; both are fine).
  await tx.insert(numberSeries).values({ shopId, series, fy }).onConflictDoNothing();
  const [row] = await tx
    .update(numberSeries)
    .set({ nextValue: sql`${numberSeries.nextValue} + 1` })
    .where(and(eq(numberSeries.shopId, shopId), eq(numberSeries.series, series), eq(numberSeries.fy, fy)))
    .returning({ taken: sql<number>`${numberSeries.nextValue} - 1` });
  return { fy, number: `${series}/${fy}/${String(row!.taken).padStart(5, "0")}` };
}
