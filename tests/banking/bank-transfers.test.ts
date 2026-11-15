import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { accountBalances, activateBusinessAccounts, createBankAccount, listBankAccounts, recordOpeningBalances, trialBalance } from "@/modules/accounting";
import { bankWorkbench, importStatement, postLine } from "@/modules/banking";
import { cashMovements } from "@/modules/cashbook/schema";
import { recordCashMovement } from "@/modules/cashbook";
import { toActionError } from "@/server/action-result";
import { chosenBank, mustChooseBank } from "@/components/bank/bank-choice";
import { indiaDate } from "@/shared/financial-year";
import { addDays } from "@/shared/report-range";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

/** Explicit bank choice, and money moving between the drawer and the bank: never profit, always on the chosen account. */
const db = setupTestDatabase();
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
const START = addDays(today, -10);
const dmy = (iso: string) => iso.split("-").reverse().join("/");
const MAPPING = { hasHeader: true, dateFormat: "dmy" as const, dateColumn: 0, narrationColumn: 1, debitColumn: 2, creditColumn: 3, balanceColumn: 4, referenceColumn: null };
const csv = (rows: [string, string, string, string, string][]) => ["Date,Narration,Debit,Credit,Balance", ...rows.map((row) => row.map((cell) => `"${cell}"`).join(","))].join("\n");
type Session = Awaited<ReturnType<typeof signInAs>>["session"];
const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error, "should be refused").not.toBeNull();
  return toActionError(error);
};

let shop: TestShop;
let owner: Session;
let hdfc: string;
let sbi: string;

const net = async (systemKey: string) => {
  const row = (await accountBalances(owner)).find((entry) => entry.systemKey === systemKey);
  return (row?.debitPaise ?? 0) - (row?.creditPaise ?? 0);
};
const sbiKey = async () => (await listBankAccounts(owner)).find((account) => account.id === sbi)!.accountKey;

beforeAll(async () => {
  shop = await createTestShop(db, "Bank transfers shop");
  owner = (await signInAs(shop.users.owner)).session;
  await activateBusinessAccounts(owner, { coverageStartDate: START });
  await recordOpeningBalances(owner, { inventoryPaise: 0, cashPaise: 1000000, bankPaise: 0, upiPaise: 0, cardPaise: 0, chequesPaise: 0, other: [], unvaluedProductIds: [], receivables: [], payables: [] });
  hdfc = (await createBankAccount(owner, { name: "HDFC Current", last4: "1234", statementBalance: "0", asOf: START })).id;
  sbi = (await createBankAccount(owner, { name: "SBI Savings", last4: "9876", statementBalance: "0", asOf: START })).id;
});

describe("the bank account is always chosen when there are several", () => {
  const accounts = [
    { id: "a", name: "HDFC", last4: null, isDefault: true },
    { id: "b", name: "SBI", last4: null, isDefault: false },
  ];
  it("never preselects the first, the default or the last used", () => {
    expect(mustChooseBank(accounts)).toBe(true);
    expect(chosenBank(accounts, "")).toBe("");
    expect(chosenBank(accounts, "b")).toBe("b");
    expect(chosenBank(accounts, "gone")).toBe("");
  });
  it("asks for nothing with one account, where the server uses it", () => {
    expect(mustChooseBank([accounts[0]!])).toBe(false);
    expect(chosenBank([accounts[0]!], "")).toBe("");
  });
  it("refuses a bank movement that names no account", async () => {
    const error = await refusal(recordCashMovement(owner, { idempotencyKey: key(), businessDate: today, kind: "bank_deposit", amount: "1000" }));
    expect(error.code).toBe("BANK_CHOICE_REQUIRED");
    expect((await refusal(recordCashMovement(owner, { idempotencyKey: key(), businessDate: today, kind: "bank_withdrawal", amount: "1000" }))).code).toBe("BANK_CHOICE_REQUIRED");
  });
});

describe("cash to the bank and back", () => {
  it("a deposit moves cash to the chosen account and a withdrawal brings it back, with profit untouched", async () => {
    const cash = await net("cash");
    const profitBefore = (await net("sales")) + (await net("cogs")) + (await net("cash_shortage"));
    const { id } = await recordCashMovement(owner, { idempotencyKey: key(), businessDate: today, kind: "bank_deposit", amount: "5000", bankAccountId: sbi, note: "Deposit slip 12" });
    expect(await net("cash")).toBe(cash - 500000);
    expect(await net(await sbiKey())).toBe(500000);
    expect(await net("bank")).toBe(0); // the other account is untouched
    const [row] = await db.owner.select().from(cashMovements).where(eq(cashMovements.id, id));
    expect(row).toMatchObject({ kind: "bank_deposit", amountPaise: 500000, bankAccountId: sbi });

    const back = await recordCashMovement(owner, { idempotencyKey: key(), businessDate: today, kind: "bank_withdrawal", amount: "2000", bankAccountId: sbi });
    expect(await net("cash")).toBe(cash - 300000);
    expect(await net(await sbiKey())).toBe(300000);
    const [withdrawal] = await db.owner.select().from(cashMovements).where(eq(cashMovements.id, back.id));
    expect(withdrawal).toMatchObject({ kind: "bank_withdrawal", bankAccountId: sbi });
    expect((await net("sales")) + (await net("cogs")) + (await net("cash_shortage"))).toBe(profitBefore);
    expect((await trialBalance(owner, today)).balanced).toBe(true);
  });
});

describe("classifying a bank statement line as cash moving between the drawer and the bank", () => {
  it("a credit can be cash deposited and a debit cash withdrawn; the wrong direction is refused", async () => {
    await importStatement(owner, {
      bankAccountId: hdfc,
      fileName: "cash.csv",
      mapping: MAPPING,
      text: csv([
        [dmy(addDays(today, -3)), "CASH DEPOSIT BRANCH", "", "3,000.00", "3,000.00"],
        [dmy(addDays(today, -2)), "ATM CASH WITHDRAWAL", "500.00", "", "2,500.00"],
      ]),
    });
    const lines = (await bankWorkbench(owner, hdfc)).lines;
    const credit = lines.find((line) => line.creditPaise > 0)!;
    const debit = lines.find((line) => line.debitPaise > 0)!;
    // Each line only offers its own direction.
    expect((await refusal(postLine(owner, { idempotencyKey: key(), lineId: credit.id, kind: "cash_withdrawn", confirm: true }))).error).toMatch(/money received/);
    expect((await refusal(postLine(owner, { idempotencyKey: key(), lineId: debit.id, kind: "cash_deposited", confirm: true }))).error).toMatch(/money paid out/);

    const cash = await net("cash");
    const bank = await net("bank");
    const profitBefore = (await net("sales")) + (await net("expense_other")) + (await net("owner_drawings"));
    await postLine(owner, { idempotencyKey: key(), lineId: credit.id, kind: "cash_deposited", confirm: true });
    expect(await net("cash")).toBe(cash - 300000); // the drawer lost what the bank received
    expect(await net("bank")).toBe(bank + 300000);
    await postLine(owner, { idempotencyKey: key(), lineId: debit.id, kind: "cash_withdrawn", confirm: true });
    expect(await net("cash")).toBe(cash - 300000 + 50000);
    expect(await net("bank")).toBe(bank + 300000 - 50000);
    // Neither is drawings, income or an expense.
    expect((await net("sales")) + (await net("expense_other")) + (await net("owner_drawings"))).toBe(profitBefore);
    expect((await trialBalance(owner, today)).balanced).toBe(true);
  });
});
