import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { accountBalances, activateBusinessAccounts, bookBalanceOn, createBankAccount, listBankAccounts } from "@/modules/accounting";
import { accounts, journals } from "@/modules/accounting/schema";
import { auditLog } from "@/modules/audit/schema";
import {
  bankOverview,
  bankWorkbench,
  confirmMatch,
  finalizeReconciliation,
  ignoreLine,
  importStatement,
  listReconciliations,
  postLine,
  previewReconciliation,
  previewStatement,
  undoMatch,
} from "@/modules/banking";
import { bankMatchGroups, bankStatementLines } from "@/modules/banking/schema";
import { createCustomer } from "@/modules/parties";
import { payments } from "@/modules/payments/schema";
import { recordCustomerReceipt } from "@/modules/payments";
import { createSupplier } from "@/modules/purchasing";
import { toActionError } from "@/server/action-result";
import { indiaDate } from "@/shared/financial-year";
import { addDays } from "@/shared/report-range";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

/**
 * Bank accounts and reconciliation against real (disposable) data: importing never creates journals, duplicates are caught without
 * losing genuine repeats, UPI/card/cheque settlements move money between accounts instead of counting it twice, every posting is
 * explicit, atomic and idempotent, and finishing a reconciliation closes its days.
 */
const db = setupTestDatabase();
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
const START = addDays(today, -10);
const D1 = addDays(today, -3);
const D2 = addDays(today, -2);
const D3 = addDays(today, -1);
const dmy = (iso: string) => iso.split("-").reverse().join("/");
const MAPPING = { hasHeader: true, dateFormat: "dmy" as const, dateColumn: 0, narrationColumn: 1, debitColumn: 2, creditColumn: 3, balanceColumn: 4, referenceColumn: null };
type Session = Awaited<ReturnType<typeof signInAs>>["session"];

const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error, "should be refused").not.toBeNull();
  return (await toActionError(error)).error;
};

const csv = (rows: [string, string, string, string, string][]) => ["Date,Narration,Debit,Credit,Balance", ...rows.map((row) => row.map((cell) => `"${cell}"`).join(","))].join("\n");
const net = async (session: Session, systemKey: string) => {
  const row = (await accountBalances(session)).find((entry) => entry.systemKey === systemKey);
  return (row?.debitPaise ?? 0) - (row?.creditPaise ?? 0);
};
const journalCount = async (shopId: string) => (await db.owner.select().from(journals).where(eq(journals.shopId, shopId))).length;

let shop: TestShop;
let session: Session;
let customerId: string;
let bankId: string;
const lines: Record<string, string> = {};
const lineIdFor = async (narrationStart: string) => {
  const rows = await db.owner.select().from(bankStatementLines).where(eq(bankStatementLines.shopId, shop.shopId));
  return rows.find((row) => row.narration.startsWith(narrationStart))!.id;
};
/** The book entry on the bank account for a payment, as the matching screen offers it. */
const bankItemIds = async (paymentReference: string) => (await bankWorkbench(session, bankId)).bankItems.filter((item) => item.reference === paymentReference).map((item) => item.journalLineId);

beforeAll(async () => {
  shop = await createTestShop(db, "Bank Shop");
  session = (await signInAs(shop.users.owner)).session;
  await activateBusinessAccounts(session, { coverageStartDate: START });
  ({ id: customerId } = await createCustomer(session, { name: "Sharma Traders", phone: "9422000001", type: "retail", creditLimit: "1000000" }));
  // Money already in the books before any bank account is added: a bank transfer, two UPI receipts and a cheque.
  await recordCustomerReceipt(session, { idempotencyKey: key(), customerId, amount: "5000", method: "bank", reference: "UTR111222333" });
  await recordCustomerReceipt(session, { idempotencyKey: key(), customerId, amount: "1000", method: "upi", reference: "UPI0001" });
  await recordCustomerReceipt(session, { idempotencyKey: key(), customerId, amount: "2000", method: "upi", reference: "UPI0002" });
  await recordCustomerReceipt(session, { idempotencyKey: key(), customerId, amount: "1500", method: "cheque", reference: "CHQ555" });
});

describe("adding a bank account", () => {
  it("changes no earlier payment or journal, and the first account keeps the original bank account", async () => {
    const journalsBefore = await db.owner.select().from(journals).where(eq(journals.shopId, shop.shopId));
    const paymentsBefore = await db.owner.select().from(payments).where(eq(payments.shopId, shop.shopId));
    const bankBefore = await net(session, "bank");
    expect(bankBefore).toBe(500000);
    ({ id: bankId } = await createBankAccount(session, { name: "HDFC Current", last4: "1234", statementBalance: "0", asOf: START, addDifferenceToBooks: false }));
    expect(await db.owner.select().from(journals).where(eq(journals.shopId, shop.shopId))).toEqual(journalsBefore);
    expect(await db.owner.select().from(payments).where(eq(payments.shopId, shop.shopId))).toEqual(paymentsBefore);
    const [account] = await listBankAccounts(session);
    expect(account).toMatchObject({ isDefault: true, accountKey: "bank", openingBookPaise: 0 });
    expect(await refusal(createBankAccount(session, { name: "hdfc current", statementBalance: "0", asOf: START }))).toMatch(/already have a bank account/i);
  });

  it("is owner only and needs the books on", async () => {
    const manager = (await signInAs(shop.users.manager)).session;
    expect(await refusal(listBankAccounts(manager))).toBeTruthy();
    const off = await createTestShop(db, "Books Off Bank");
    const offSession = (await signInAs(off.users.owner)).session;
    expect(await refusal(createBankAccount(offSession, { name: "X", statementBalance: "0", asOf: START }))).toMatch(/Business Accounts/);
  });
});

describe("importing a statement", () => {
  const file = csv([
    [dmy(D1), "NEFT UTR111222333 SHARMA TRADERS", "", "5,000.00", "5,000.00"],
    [dmy(today), "UPI SETTLEMENT BATCH 7781", "", "2,940.00", "7,940.00"],
    [dmy(D2), "SMS CHARGES", "118.00", "", "7,822.00"],
    [dmy(D3), "TRANSFER RAHUL ENTERPRISES", "", "700.00", "8,522.00"],
    [dmy(D3), "ATM CASH WITHDRAWAL", "500.00", "", "8,022.00"],
    [dmy(D3), "ATM CASH WITHDRAWAL", "500.00", "", "7,522.00"],
  ]);

  it("previews without saving, then saves lines only: no journal, no payment", async () => {
    const preview = await previewStatement(session, { bankAccountId: bankId, fileName: "nov.csv", text: file, mapping: MAPPING });
    expect(preview).toMatchObject({ totalLines: 6, newLines: 6, duplicateLines: 0, problems: [], fileAlreadyImported: false });
    expect(await db.owner.select().from(bankStatementLines).where(eq(bankStatementLines.shopId, shop.shopId))).toHaveLength(0);
    const journalsBefore = await journalCount(shop.shopId);
    const paymentsBefore = (await db.owner.select().from(payments).where(eq(payments.shopId, shop.shopId))).length;
    const result = await importStatement(session, { bankAccountId: bankId, fileName: "nov.csv", text: file, mapping: MAPPING });
    expect(result).toMatchObject({ imported: 6, duplicates: 0 });
    expect(await journalCount(shop.shopId)).toBe(journalsBefore);
    expect((await db.owner.select().from(payments).where(eq(payments.shopId, shop.shopId))).length).toBe(paymentsBefore);
  });

  it("keeps both of two genuinely identical lines", async () => {
    const rows = await db.owner.select().from(bankStatementLines).where(eq(bankStatementLines.shopId, shop.shopId));
    expect(rows.filter((row) => row.narration === "ATM CASH WITHDRAWAL")).toHaveLength(2);
  });

  it("refuses the same file again, and recognises repeated lines in an overlapping file", async () => {
    expect(await refusal(importStatement(session, { bankAccountId: bankId, fileName: "again.csv", text: file, mapping: MAPPING }))).toMatch(/already imported/i);
    const overlap = csv([
      [dmy(D3), "TRANSFER RAHUL ENTERPRISES", "", "700.00", "8,522.00"],
      [dmy(D3), "ATM CASH WITHDRAWAL", "500.00", "", "8,022.00"],
      [dmy(D3), "BANK INTEREST", "", "12.00", "7,534.00"],
    ]);
    const result = await importStatement(session, { bankAccountId: bankId, fileName: "overlap.csv", text: overlap, mapping: MAPPING });
    expect(result).toMatchObject({ imported: 1, duplicates: 2 });
    const rows = await db.owner.select().from(bankStatementLines).where(eq(bankStatementLines.shopId, shop.shopId));
    expect(rows).toHaveLength(7);
  });

  it("refuses a file with unreadable rows and saves nothing", async () => {
    const bad = csv([["31/02/2026", "x", "1.00", "", ""]]);
    const before = (await db.owner.select().from(bankStatementLines).where(eq(bankStatementLines.shopId, shop.shopId))).length;
    expect(await refusal(importStatement(session, { bankAccountId: bankId, fileName: "bad.csv", text: bad, mapping: MAPPING }))).toMatch(/could not be read/i);
    expect((await db.owner.select().from(bankStatementLines).where(eq(bankStatementLines.shopId, shop.shopId))).length).toBe(before);
  });
});

describe("matching and settling", () => {
  it("suggests, but does not apply, a match and a settlement", async () => {
    const bench = await bankWorkbench(session, bankId);
    const direct = bench.suggestions.find((suggestion) => suggestion.kind === "match");
    const settle = bench.suggestions.find((suggestion) => suggestion.kind === "settlement");
    expect(direct).toBeTruthy();
    expect(settle).toMatchObject({ feePaise: 6000, grossPaise: 300000 });
    expect(bench.lines.every((line) => line.status === "unmatched")).toBe(true);
  });

  it("refuses a match whose amounts do not agree", async () => {
    const line = await lineIdFor("SMS CHARGES");
    const items = await bankItemIds("UTR111222333");
    expect(items).toHaveLength(1);
    expect(await refusal(confirmMatch(session, { idempotencyKey: key(), bankAccountId: bankId, lineIds: [line], itemIds: items }))).toMatch(/do not add up/i);
  });

  it("matches a line to something already in the books without posting anything", async () => {
    lines.transfer = await lineIdFor("NEFT UTR111222333");
    const items = await bankItemIds("UTR111222333");
    const before = await journalCount(shop.shopId);
    const result = await confirmMatch(session, { idempotencyKey: key(), bankAccountId: bankId, lineIds: [lines.transfer], itemIds: items });
    expect(result).toMatchObject({ kind: "match", feePaise: 0 });
    expect(await journalCount(shop.shopId)).toBe(before);
    expect(await net(session, "bank")).toBe(500000);
  });

  it("settles UPI receipts into the bank less the fee, moving money between accounts without touching sales", async () => {
    lines.settlement = await lineIdFor("UPI SETTLEMENT");
    const upi1 = (await bankItemIdsOn("upi")).filter((row) => row.signed === 100000 || row.signed === 200000).map((row) => row.id);
    expect(upi1).toHaveLength(2);
    expect(await net(session, "upi")).toBe(300000);
    const salesBefore = await net(session, "sales");
    const key1 = key();
    const result = await confirmMatch(session, { idempotencyKey: key1, bankAccountId: bankId, lineIds: [lines.settlement], itemIds: upi1 });
    expect(result).toMatchObject({ kind: "settlement", feePaise: 6000 });
    expect(await net(session, "upi")).toBe(0);
    expect(await net(session, "bank")).toBe(500000 + 294000);
    expect(await net(session, "bank_charges")).toBe(6000);
    expect(await net(session, "sales")).toBe(salesBefore);
    // The same confirmation sent again (double click, retry) changes nothing.
    const again = await confirmMatch(session, { idempotencyKey: key1, bankAccountId: bankId, lineIds: [lines.settlement], itemIds: upi1 });
    expect(again).toMatchObject({ groupId: result.groupId, replayed: true });
    expect(await net(session, "bank")).toBe(794000);
  });

  it("will not use the same entry or line twice, even with a different key", async () => {
    const upi = await bankItemIdsOn("upi");
    expect(upi.filter((row) => row.signed === 100000)).toHaveLength(0); // already settled: no longer offered
    expect(await refusal(confirmMatch(session, { idempotencyKey: key(), bankAccountId: bankId, lineIds: [lines.transfer], itemIds: [1] }))).toMatch(/already been explained/i);
  });

  it("keeps a cheque outstanding until the bank clears it, and asks before accepting a large fee", async () => {
    expect(await net(session, "cheques")).toBe(150000);
    const cheque = (await bankItemIdsOn("cheques"))[0]!;
    const rows = await importStatement(session, { bankAccountId: bankId, fileName: "chq.csv", mapping: MAPPING, text: csv([[dmy(today), "CHQ DEPOSIT 555", "", "1,000.00", "8,534.00"]]) });
    expect(rows.imported).toBe(1);
    const line = await lineIdFor("CHQ DEPOSIT");
    // 1,000 against a 1,500 cheque is a 33% fee: refused unless the owner confirms it.
    expect(await refusal(confirmMatch(session, { idempotencyKey: key(), bankAccountId: bankId, lineIds: [line], itemIds: [cheque.id] }))).toMatch(/more than 3%/);
    expect(await net(session, "cheques")).toBe(150000);
    // The bank credit is left for the owner to deal with below; the cheque stays outstanding.
    lines.cheque = line;
  });
});

describe("posting lines nothing explains", () => {
  it("needs an explicit confirmation", async () => {
    const line = await lineIdFor("SMS CHARGES");
    const before = await journalCount(shop.shopId);
    await expect(postLine(session, { idempotencyKey: key(), lineId: line, kind: "bank_charge", confirm: false })).rejects.toBeTruthy();
    expect(await journalCount(shop.shopId)).toBe(before);
  });

  it("posts a bank charge once, even if sent twice", async () => {
    const line = await lineIdFor("SMS CHARGES");
    const k = key();
    const first = await postLine(session, { idempotencyKey: k, lineId: line, kind: "bank_charge", confirm: true });
    const second = await postLine(session, { idempotencyKey: k, lineId: line, kind: "bank_charge", confirm: true });
    expect(second).toMatchObject({ groupId: first.groupId, replayed: true });
    expect(await net(session, "bank_charges")).toBe(6000 + 11800);
    expect(await refusal(postLine(session, { idempotencyKey: key(), lineId: line, kind: "bank_charge", confirm: true }))).toMatch(/already been explained/i);
  });

  it("refuses a kind that does not fit the line's direction", async () => {
    const credit = await lineIdFor("TRANSFER RAHUL");
    expect(await refusal(postLine(session, { idempotencyKey: key(), lineId: credit, kind: "bank_charge", confirm: true }))).toMatch(/money received/i);
  });

  it("records a customer's transfer as a receipt in the bank account with ledger and journal together", async () => {
    const line = await lineIdFor("TRANSFER RAHUL");
    const bankBefore = await net(session, "bank");
    const result = await postLine(session, { idempotencyKey: key(), lineId: line, kind: "customer_receipt", partyId: customerId, confirm: true });
    expect(result.paymentId).toBeTruthy();
    const [payment] = await db.owner.select().from(payments).where(eq(payments.id, result.paymentId!));
    expect(payment).toMatchObject({ method: "bank", direction: "in", amountPaise: 70000, bankAccountId: bankId });
    expect(await net(session, "bank")).toBe(bankBefore + 70000);
    const [group] = await db.owner.select().from(bankMatchGroups).where(eq(bankMatchGroups.id, result.groupId));
    expect(group).toMatchObject({ kind: "posting", postingKind: "customer_receipt", status: "active", paymentId: payment!.id });
    // It cannot be undone from the bank screen; the receipt is reversed from its own page.
    expect(await refusal(undoMatch(session, { idempotencyKey: key(), groupId: result.groupId, reason: "mistake entered" }))).toMatch(/reverse that receipt/i);
  });

  it("will not add a payment whose reference is already recorded", async () => {
    await importStatement(session, { bankAccountId: bankId, fileName: "dup.csv", mapping: MAPPING, text: csv([[dmy(today), "NEFT UTR111222333 AGAIN", "", "5,000.00", ""]]) });
    const line = await lineIdFor("NEFT UTR111222333 AGAIN");
    expect(await refusal(postLine(session, { idempotencyKey: key(), lineId: line, kind: "customer_receipt", partyId: customerId, confirm: true }))).toMatch(/already recorded/i);
    await ignoreLine(session, { lineId: line, reason: "Same transfer shown twice by the bank" });
  });

  it("pays a supplier from a debit line only up to what is owed", async () => {
    const { id: supplierId } = await createSupplier(session, { name: "Bank Supplier", phone: "", gstin: "", paymentTermsDays: "30" });
    await importStatement(session, { bankAccountId: bankId, fileName: "sup.csv", mapping: MAPPING, text: csv([[dmy(today), "RTGS BANK SUPPLIER", "900.00", "", ""]]) });
    const line = await lineIdFor("RTGS BANK SUPPLIER");
    expect(await refusal(postLine(session, { idempotencyKey: key(), lineId: line, kind: "supplier_payment", partyId: supplierId, confirm: true }))).toMatch(/anything right now|more than that/i);
    await ignoreLine(session, { lineId: line, reason: "Not a supplier payment" });
  });
});

describe("undoing a match", () => {
  it("returns the lines and entries, reverses the settlement journal, and keeps the record of the undo", async () => {
    const [group] = await db.owner.select().from(bankMatchGroups).where(eq(bankMatchGroups.kind, "settlement"));
    expect(await refusal(undoMatch(session, { idempotencyKey: key(), groupId: group!.id, reason: "" }))).toBeTruthy();
    await undoMatch(session, { idempotencyKey: key(), groupId: group!.id, reason: "Chose the wrong batch" });
    expect(await net(session, "upi")).toBe(300000);
    expect(await net(session, "bank")).toBe(500000 + 70000 - 11800);
    expect(await net(session, "bank_charges")).toBe(11800);
    const [after] = await db.owner.select().from(bankMatchGroups).where(eq(bankMatchGroups.id, group!.id));
    expect(after).toMatchObject({ status: "undone", undoReason: "Chose the wrong batch" });
    const audit = await db.owner.select().from(auditLog).where(eq(auditLog.shopId, shop.shopId));
    expect(audit.some((row) => row.action === "bank.unmatched")).toBe(true);
    // The same line can now be settled again, correctly.
    const upi = (await bankItemIdsOn("upi")).filter((row) => row.signed === 100000 || row.signed === 200000).map((row) => row.id);
    await confirmMatch(session, { idempotencyKey: key(), bankAccountId: bankId, lineIds: [lines.settlement], itemIds: upi });
    expect(await net(session, "upi")).toBe(0);
    expect(await net(session, "bank")).toBe(500000 + 294000 + 70000 - 11800);
  });
});

describe("a second bank account", () => {
  it("has its own account, receives chosen bank payments, and leaves the first alone", async () => {
    const { id: secondId } = await createBankAccount(session, { name: "SBI Savings", last4: "9876", statementBalance: "10000", asOf: START, addDifferenceToBooks: true });
    const rows = await listBankAccounts(session);
    const second = rows.find((row) => row.id === secondId)!;
    expect(second.accountKey).toBe(`bank:${secondId}`);
    expect(second.isDefault).toBe(false);
    expect(second.bookBalancePaise).toBe(1000000); // the confirmed opening difference
    expect(second.openingBookPaise).toBe(1000000);
    const firstBefore = await net(session, "bank");
    await recordCustomerReceipt(session, { idempotencyKey: key(), customerId, amount: "300", method: "bank", reference: "SBI0001", bankAccountId: secondId });
    expect((await listBankAccounts(session)).find((row) => row.id === secondId)!.bookBalancePaise).toBe(1030000);
    expect(await net(session, "bank")).toBe(firstBefore);
    const [accountRow] = await db.owner.select().from(accounts).where(eq(accounts.systemKey, `bank:${secondId}`));
    expect(accountRow).toMatchObject({ type: "asset", category: "cash_and_bank", cashFlow: "cash" });
  });
});

describe("reconciliation", () => {
  it("shows what is left to explain and will not finish until every line is dealt with", async () => {
    const preview = await previewReconciliation(session, { bankAccountId: bankId, statementDate: today, statementBalance: "10000" });
    expect(preview.unresolvedLines).toBeGreaterThan(0);
    expect(preview.canFinish).toBe(false);
    expect(await refusal(finalizeReconciliation(session, { idempotencyKey: key(), bankAccountId: bankId, statementDate: today, statementBalance: "10000" }))).toMatch(/not explained/i);
  });

  it("finishes only when the figures agree, and then keeps its history and closes those days", async () => {
    // Deal with the remaining lines: the ATM withdrawals are the owner's drawings, the interest is interest, the cheque credit is left out for now.
    for (const [start, kind] of [["ATM CASH WITHDRAWAL", "owner_out"], ["BANK INTEREST", "bank_interest"]] as const) {
      const rows = await db.owner.select().from(bankStatementLines).where(eq(bankStatementLines.shopId, shop.shopId));
      for (const row of rows.filter((candidate) => candidate.narration.startsWith(start) && candidate.status === "unmatched")) await postLine(session, { idempotencyKey: key(), lineId: row.id, kind, confirm: true });
    }
    await ignoreLine(session, { lineId: lines.cheque, reason: "Cheque credit will be matched next month" });
    const book = await bookBalanceOn(db.owner, shop.shopId, (await db.owner.select().from(accounts).where(eq(accounts.systemKey, "bank")))[0]!.id, today);
    expect(book).toBe(753400);
    // Statement closing = what the lines add up to: 5,000 + 2,940 - 118 + 700 - 500 - 500 + 12 + (left out: cheque credit 1,000 + repeated transfer 5,000 - supplier debit 900).
    const closing = 12634;
    const wrong = await previewReconciliation(session, { bankAccountId: bankId, statementDate: today, statementBalance: String(closing + 50) });
    expect(wrong.canFinish).toBe(false);
    expect(wrong.differencePaise).toBe(5000);
    expect(await refusal(finalizeReconciliation(session, { idempotencyKey: key(), bankAccountId: bankId, statementDate: today, statementBalance: String(closing + 50) }))).toMatch(/still differ by/i);
    const right = await previewReconciliation(session, { bankAccountId: bankId, statementDate: today, statementBalance: String(closing) });
    expect(right).toMatchObject({ differencePaise: 0, unresolvedLines: 0, canFinish: true, ignoredPaise: 510000 });
    const done = await finalizeReconciliation(session, { idempotencyKey: key(), bankAccountId: bankId, statementDate: today, statementBalance: String(closing), note: "November" });
    expect(done.differencePaise).toBe(0);
    const history = await listReconciliations(session, bankId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ statementDate: today, note: "November", differencePaise: 0 });
    // The period is closed: lines in it can no longer be changed, and the history cannot be edited.
    const settlement = (await db.owner.select().from(bankMatchGroups).where(eq(bankMatchGroups.shopId, shop.shopId))).find((group) => group.kind === "settlement" && group.status === "active");
    expect(await refusal(undoMatch(session, { idempotencyKey: key(), groupId: settlement!.id, reason: "Changing my mind" }))).toMatch(/reconciled and is closed/i);
    expect(await refusal(finalizeReconciliation(session, { idempotencyKey: key(), bankAccountId: bankId, statementDate: today, statementBalance: String(closing) }))).toMatch(/already reconciled/i);
    await expect(db.owner.execute(sql`update bank_reconciliations set note = 'x'`)).rejects.toBeTruthy();
    const overview = await bankOverview(session);
    expect(overview.find((row) => row.id === bankId)).toMatchObject({ reconciledThrough: today, unmatchedLines: 0 });
  });
});

describe("the database itself", () => {
  it("never lets a statement line's text or amount change, or a match be reopened", async () => {
    const [line] = await db.owner.select().from(bankStatementLines).where(eq(bankStatementLines.shopId, shop.shopId));
    await expect(db.owner.update(bankStatementLines).set({ creditPaise: 1 }).where(eq(bankStatementLines.id, line!.id))).rejects.toBeTruthy();
    await expect(db.owner.delete(bankStatementLines).where(eq(bankStatementLines.id, line!.id))).rejects.toBeTruthy();
    const [group] = await db.owner.select().from(bankMatchGroups).where(eq(bankMatchGroups.status, "undone"));
    await expect(db.owner.update(bankMatchGroups).set({ status: "active" }).where(eq(bankMatchGroups.id, group!.id))).rejects.toBeTruthy();
  });
});

/** Entries waiting on the not-yet-in-bank accounts, as the matching screen would offer them. */
async function bankItemIdsOn(systemKey: "upi" | "cheques") {
  const bench = await bankWorkbench(session, bankId, "all");
  return bench.clearingItems.filter((item) => item.accountKey === systemKey).map((item) => ({ id: item.journalLineId, signed: item.signedPaise }));
}
