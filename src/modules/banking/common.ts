import { and, desc, eq } from "drizzle-orm";
import { BANK_MANAGE, loadAccountingSettings } from "@/modules/accounting";
import { accounts, bankAccounts } from "@/modules/accounting/schema";
import type { SessionContext } from "@/modules/identity";
import type { Database, Transaction } from "@/server/db";
import { ConflictError, NotFoundError } from "@/server/errors";
import { bankReconciliations } from "./schema";

export { BANK_MANAGE };
export type Db = Database | Transaction;
export const actorOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId, role: session.role });
export const booksOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId });
export const isUuid = (value: string) => /^[0-9a-f-]{36}$/i.test(value);
export const num = (value: unknown) => Number(value ?? 0);

export type LoadedBank = { id: string; accountId: string; accountKey: string; name: string; openingAsOf: string; openingStatementPaise: number; openingBookPaise: number; isActive: boolean; csvMapping: Record<string, unknown> | null };

/** The bank account of this shop, optionally locked for the rest of the transaction (imports and reconciliations are one at a time). */
export async function loadBank(db: Db, shopId: string, bankAccountId: string, options: { lock?: boolean } = {}): Promise<LoadedBank> {
  if (!isUuid(bankAccountId)) throw new NotFoundError("Bank account not found.");
  const query = db
    .select({ bank: bankAccounts, key: accounts.systemKey })
    .from(bankAccounts)
    .innerJoin(accounts, eq(accounts.id, bankAccounts.accountId))
    .where(and(eq(bankAccounts.shopId, shopId), eq(bankAccounts.id, bankAccountId)))
    .limit(1);
  const [row] = await (options.lock ? query.for("update", { of: bankAccounts }) : query);
  if (!row) throw new NotFoundError("Bank account not found.");
  const { bank, key } = row;
  return { id: bank.id, accountId: bank.accountId, accountKey: key, name: bank.name, openingAsOf: bank.openingAsOf, openingStatementPaise: bank.openingStatementPaise, openingBookPaise: bank.openingBookPaise, isActive: bank.isActive, csvMapping: bank.csvMapping };
}

/** Bank work needs the books on: matching and posting are journals. */
export async function requireBooks(db: Db, shopId: string) {
  const settings = await loadAccountingSettings(db, shopId);
  if (!settings) throw new ConflictError("BOOKS_OFF", "Turn on Business Accounts first. Bank reconciliation works on your books.");
  return settings;
}

/** The last day a reconciliation was finished for. Lines on or before it are settled and are not changed again. */
export async function lastFinalizedDate(db: Db, shopId: string, bankAccountId: string): Promise<string | null> {
  const [row] = await db
    .select({ date: bankReconciliations.statementDate })
    .from(bankReconciliations)
    .where(and(eq(bankReconciliations.shopId, shopId), eq(bankReconciliations.bankAccountId, bankAccountId)))
    .orderBy(desc(bankReconciliations.statementDate))
    .limit(1);
  return row?.date ?? null;
}

export const isRealDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
