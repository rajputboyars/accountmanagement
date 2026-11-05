import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { v7 as uuidv7 } from "uuid";
import { recordAudit } from "@/modules/audit";
import { requirePermission, type SessionContext } from "@/modules/identity";
import { getDb, withTransaction, type Database, type Transaction } from "@/server/db";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { bankAccountKey } from "@/shared/accounting";
import { parseRupeesToPaise } from "@/shared/money";
import { postBankOpening } from "./events";
import { ensureChart } from "./service";
import { accounts, accountingSettings, bankAccounts } from "./schema";

/**
 * Bank accounts. Each is a real account in the books. The first one added keeps the original "bank" account, so every
 * earlier payment, journal and report stays exactly as it was; later ones get their own account. Adding one changes no history.
 */

export const BANK_MANAGE = "settings.edit" as const; // owner only, like turning the books on

type Db = Database | Transaction;
const actorOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId, role: session.role });
const isRealDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export type BankAccountView = {
  id: string;
  accountId: string;
  accountKey: string;
  name: string;
  last4: string | null;
  isDefault: boolean;
  isActive: boolean;
  openingAsOf: string;
  openingStatementPaise: number;
  openingBookPaise: number;
  csvMapping: Record<string, unknown> | null;
  bookBalancePaise: number;
};

/** What the books say this account holds at the end of a date: everything debited minus everything credited to it. */
export async function bookBalanceOn(db: Db, shopId: string, accountId: string, date: string | null): Promise<number> {
  const result = await db.execute<{ amount: string | null }>(sql`
    select coalesce(sum(l.debit_paise - l.credit_paise), 0)::text as amount
    from journal_lines l join journals j on j.id = l.journal_id
    where l.shop_id = ${shopId} and l.account_id = ${accountId}::uuid ${date ? sql`and j.entry_date <= ${date}::date` : sql``}`);
  return Number(result.rows[0]?.amount ?? 0);
}

async function viewsOf(db: Db, shopId: string, onlyId?: string): Promise<BankAccountView[]> {
  const rows = await db
    .select({ bank: bankAccounts, key: accounts.systemKey })
    .from(bankAccounts)
    .innerJoin(accounts, eq(accounts.id, bankAccounts.accountId))
    .where(onlyId ? and(eq(bankAccounts.shopId, shopId), eq(bankAccounts.id, onlyId)) : eq(bankAccounts.shopId, shopId))
    .orderBy(asc(bankAccounts.createdAt));
  const result: BankAccountView[] = [];
  for (const { bank, key } of rows) {
    result.push({
      id: bank.id,
      accountId: bank.accountId,
      accountKey: key,
      name: bank.name,
      last4: bank.last4,
      isDefault: bank.isDefault,
      isActive: bank.isActive,
      openingAsOf: bank.openingAsOf,
      openingStatementPaise: bank.openingStatementPaise,
      openingBookPaise: bank.openingBookPaise,
      csvMapping: bank.csvMapping,
      bookBalancePaise: await bookBalanceOn(db, shopId, bank.accountId, null),
    });
  }
  return result;
}

export async function listBankAccounts(session: SessionContext): Promise<BankAccountView[]> {
  await requirePermission(session, BANK_MANAGE);
  return viewsOf(getDb(), session.shopId);
}

export async function getBankAccount(session: SessionContext, id: string, db: Db = getDb()): Promise<BankAccountView> {
  await requirePermission(session, BANK_MANAGE);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError("Bank account not found.");
  const [row] = await viewsOf(db, session.shopId, id);
  if (!row) throw new NotFoundError("Bank account not found.");
  return row;
}

/** The chart account a bank payment posts to, for an active bank account of this shop. Throws when the account is unknown or switched off. */
export async function bankAccountKeyOf(db: Db, shopId: string, bankAccountId: string, options: { requireActive?: boolean } = {}): Promise<string> {
  const [row] = await db
    .select({ key: accounts.systemKey, active: bankAccounts.isActive })
    .from(bankAccounts)
    .innerJoin(accounts, eq(accounts.id, bankAccounts.accountId))
    .where(and(eq(bankAccounts.shopId, shopId), eq(bankAccounts.id, bankAccountId)))
    .limit(1);
  if (!row) throw new NotFoundError("Bank account not found.");
  if (options.requireActive && !row.active) throw new ConflictError("BANK_OFF", "This bank account is switched off.");
  return row.key;
}

/** The active bank accounts, for choosing one on a payment form. Anyone who can record a payment may see the names; nothing else about them. */
export async function listBankChoices(session: SessionContext): Promise<{ id: string; name: string; last4: string | null; isDefault: boolean }[]> {
  return getDb()
    .select({ id: bankAccounts.id, name: bankAccounts.name, last4: bankAccounts.last4, isDefault: bankAccounts.isDefault })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.shopId, session.shopId), eq(bankAccounts.isActive, true)))
    .orderBy(asc(bankAccounts.createdAt));
}

const createSchema = z.object({
  name: z.string().trim().min(1, "Give this account a name, for example the bank's name.").max(60),
  last4: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || null)
    .refine((value) => value === null || /^\d{4}$/.test(value), "Enter the last 4 digits of the account number, or leave it empty."),
  statementBalance: z.string().trim().min(1, "Enter the balance shown on your latest bank statement."),
  asOf: z.string().refine(isRealDate, "Choose the date of that balance."),
  addDifferenceToBooks: z.boolean().default(false),
});

/** Parses "1,234.50" or "-500" into paise. Unlike a payment amount, a bank balance can be zero or negative (overdraft). */
function balanceToPaise(value: string): number | null {
  const negative = value.trim().startsWith("-");
  const paise = parseRupeesToPaise(value.trim().replace(/^-/, "") || "0");
  if (paise === null) return null;
  return negative ? -paise : paise;
}

export async function createBankAccount(session: SessionContext, input: unknown): Promise<{ id: string }> {
  await requirePermission(session, BANK_MANAGE);
  const data = createSchema.parse(input);
  const statementPaise = balanceToPaise(data.statementBalance);
  if (statementPaise === null) throw new ValidationError("Enter the balance as an amount, for example 25000 or 25,000.50.", { fieldErrors: { statementBalance: "Enter an amount." } });
  return withTransaction(async (tx) => {
    // Serialised on the shop's settings row, so two accounts cannot take the same account code.
    const [settings] = await tx.select().from(accountingSettings).where(eq(accountingSettings.shopId, session.shopId)).for("update").limit(1);
    if (!settings) throw new ConflictError("BOOKS_OFF", "Turn on Business Accounts first. Bank accounts are kept in your books.");
    if (data.asOf < settings.coverageStartDate) throw new ValidationError("Choose a date on or after your books start.", { fieldErrors: { asOf: `Your books start on ${settings.coverageStartDate}.` } });
    await ensureChart(tx, session.shopId);
    const existing = await tx.select({ id: bankAccounts.id }).from(bankAccounts).where(eq(bankAccounts.shopId, session.shopId));
    const isDefault = existing.length === 0;
    const bankId = uuidv7();
    let accountId: string;
    if (isDefault) {
      const [chart] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.shopId, session.shopId), eq(accounts.systemKey, "bank"))).limit(1);
      accountId = chart!.id;
    } else {
      const [created] = await tx
        .insert(accounts)
        .values({ shopId: session.shopId, systemKey: bankAccountKey(bankId), code: String(1060 + existing.length - 1), name: data.name, type: "asset", category: "cash_and_bank", cashFlow: "cash" })
        .returning({ id: accounts.id });
      accountId = created!.id;
    }
    const book = await bookBalanceOn(tx, session.shopId, accountId, data.asOf);
    const difference = statementPaise - book;
    try {
      await tx.insert(bankAccounts).values({ id: bankId, shopId: session.shopId, accountId, name: data.name, last4: data.last4, isDefault, openingAsOf: data.asOf, openingStatementPaise: statementPaise, openingBookPaise: book, createdBy: session.userId });
    } catch (error) {
      if ((error as { code?: string; cause?: { code?: string } }).code === "23505" || (error as { cause?: { code?: string } }).cause?.code === "23505") throw new ConflictError("BANK_ACCOUNT_EXISTS", "You already have a bank account with this name.");
      throw error;
    }
    let openingBookPaise = book;
    if (data.addDifferenceToBooks && difference !== 0) {
      const key = isDefault ? "bank" : bankAccountKey(bankId);
      await postBankOpening(tx, { shopId: session.shopId, userId: session.userId }, { bankAccountId: bankId, date: data.asOf, bankAccount: key, differencePaise: difference });
      openingBookPaise = await bookBalanceOn(tx, session.shopId, accountId, data.asOf);
      await tx.update(bankAccounts).set({ openingBookPaise }).where(eq(bankAccounts.id, bankId));
    }
    await recordAudit(tx, actorOf(session), { action: "bank.account_added", entityType: "bank_account", entityId: bankId, after: { name: data.name, isDefault, asOf: data.asOf, statementPaise, bookPaise: openingBookPaise, differenceAddedToBooks: data.addDifferenceToBooks && difference !== 0 } });
    return { id: bankId };
  });
}

export async function setBankAccountActive(session: SessionContext, id: string, active: boolean): Promise<void> {
  await requirePermission(session, BANK_MANAGE);
  await withTransaction(async (tx) => {
    const [row] = await tx.select().from(bankAccounts).where(and(eq(bankAccounts.shopId, session.shopId), eq(bankAccounts.id, id))).for("update").limit(1);
    if (!row) throw new NotFoundError("Bank account not found.");
    if (row.isDefault && !active) throw new ConflictError("DEFAULT_BANK", "The first bank account cannot be switched off. It holds your earlier payments.");
    await tx.update(bankAccounts).set({ isActive: active }).where(eq(bankAccounts.id, id));
    await recordAudit(tx, actorOf(session), { action: active ? "bank.account_on" : "bank.account_off", entityType: "bank_account", entityId: id });
  });
}

/** The column mapping the owner chose, kept for this account so the next statement imports in one step. */
export async function saveCsvMapping(db: Db, shopId: string, bankAccountId: string, mapping: Record<string, unknown>): Promise<void> {
  await db.update(bankAccounts).set({ csvMapping: mapping }).where(and(eq(bankAccounts.shopId, shopId), eq(bankAccounts.id, bankAccountId)));
}

