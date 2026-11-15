import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activateBusinessAccounts, createBankAccount } from "@/modules/accounting";
import { ignoreLine, importStatement, unmatchedBankSummary } from "@/modules/banking";
import { bankStatementLines } from "@/modules/banking/schema";
import { closeDay, getCashbook, listClosings } from "@/modules/cashbook";
import { indiaDate } from "@/shared/financial-year";
import { addDays } from "@/shared/report-range";
import { createTestShop, signInAs } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

/** Bank lines waiting to be matched are a reminder for the owner; they never stop the day from closing. */
const db = setupTestDatabase();
const today = indiaDate();
const START = addDays(today, -10);
const dmy = (iso: string) => iso.split("-").reverse().join("/");
const MAPPING = { hasHeader: true, dateFormat: "dmy" as const, dateColumn: 0, narrationColumn: 1, debitColumn: 2, creditColumn: 3, balanceColumn: 4, referenceColumn: null };
const csv = (rows: string[][]) => ["Date,Narration,Debit,Credit,Balance", ...rows.map((row) => row.map((cell) => `"${cell}"`).join(","))].join("\n");

describe("unmatched bank lines reminder", () => {
  it("counts only lines still waiting, per account, for the owner only, and never blocks closing the day", async () => {
    const shop = await createTestShop(db, "Reminder shop");
    const owner = (await signInAs(shop.users.owner)).session;
    const manager = (await signInAs(shop.users.manager)).session;
    const cashier = (await signInAs(shop.users.cashier)).session;
    await activateBusinessAccounts(owner, { coverageStartDate: START });

    // Nothing to remind about before any bank account or statement exists.
    expect(await unmatchedBankSummary(owner)).toEqual({ total: 0, amountPaise: 0, accounts: [] });

    const { id: bankId } = await createBankAccount(owner, { name: "Reminder Bank", statementBalance: "0", asOf: START });
    await importStatement(owner, {
      bankAccountId: bankId,
      fileName: "r.csv",
      mapping: MAPPING,
      text: csv([
        [dmy(addDays(today, -3)), "NEFT FROM SOMEONE", "", "1,000.00", "1,000.00"],
        [dmy(addDays(today, -2)), "SMS CHARGES", "20.00", "", "980.00"],
        [dmy(addDays(today, -1)), "CASH DEPOSIT", "", "500.00", "1,480.00"],
      ]),
    });
    expect(await unmatchedBankSummary(owner)).toEqual({ total: 3, amountPaise: 150000 + 2000, accounts: [{ id: bankId, name: "Reminder Bank", count: 3, amountPaise: 152000 }] });

    // Only people who manage the bank are told; everyone else sees nothing and no error.
    expect(await unmatchedBankSummary(manager)).toBeNull();
    expect(await unmatchedBankSummary(cashier)).toBeNull();

    // A line the owner chose to ignore no longer counts.
    const [line] = await db.owner.select().from(bankStatementLines).where(eq(bankStatementLines.shopId, shop.shopId));
    await ignoreLine(owner, { lineId: line!.id, reason: "Not a business transaction" });
    expect((await unmatchedBankSummary(owner))!.total).toBe(2);

    // The day still closes with lines waiting: the reminder never gets in the way.
    const book = await getCashbook(owner, today);
    await closeDay(owner, { businessDate: today, counted: String(book.expectedPaise / 100) });
    expect((await listClosings(owner, 5)).some((closing) => closing.businessDate === today)).toBe(true);
    expect((await unmatchedBankSummary(owner))!.total).toBe(2);
  });
});
