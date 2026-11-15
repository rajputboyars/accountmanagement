import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accountBalances, activateBusinessAccounts, createBankAccount, recordOpeningBalances } from "@/modules/accounting";
import { accountingSettings, journalLines, journals } from "@/modules/accounting/schema";
import { bankWorkbench, confirmMatch, importStatement, postLine } from "@/modules/banking";
import { auditLog } from "@/modules/audit/schema";
import { closeDay, getCashbook, recordExpense, submitDrawerCount } from "@/modules/cashbook";
import { dayClosings, drawerCounts } from "@/modules/cashbook/schema";
import { createProduct } from "@/modules/catalog";
import { recordOpeningStock } from "@/modules/inventory";
import { recordCustomerReceipt } from "@/modules/payments";
import { createCustomer } from "@/modules/parties";
import { createInvoice, previewBill } from "@/modules/sales";
import { shops } from "@/modules/settings/schema";
import { toActionError } from "@/server/action-result";
import { indiaDate } from "@/shared/financial-year";
import { addDays } from "@/shared/report-range";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

/**
 * UPI, card and cheque money settled by the bank after the day was closed: the settlement is booked on its statement date
 * without reopening the day, and everything else stays locked.
 */
const db = setupTestDatabase();
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
const START = addDays(today, -10);
const dmy = (iso: string) => iso.split("-").reverse().join("/");
const MAPPING = { hasHeader: true, dateFormat: "dmy" as const, dateColumn: 0, narrationColumn: 1, debitColumn: 2, creditColumn: 3, balanceColumn: 4, referenceColumn: null };
const csv = (rows: string[][]) => ["Date,Narration,Debit,Credit,Balance", ...rows.map((r) => r.map((c) => `"${c}"`).join(","))].join("\n");
type Session = Awaited<ReturnType<typeof signInAs>>["session"];
let counter = 0;
const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error, "should be refused").not.toBeNull();
  return toActionError(error);
};

async function setup() {
  counter += 1;
  const shop: TestShop = await createTestShop(db, `Settlement shop ${counter}`);
  await db.owner.update(shops).set({ openingCashPaise: 100000 }).where(eq(shops.id, shop.shopId));
  const owner = (await signInAs(shop.users.owner)).session;
  await activateBusinessAccounts(owner, { coverageStartDate: START });
  await recordOpeningBalances(owner, { inventoryPaise: 0, cashPaise: 100000, bankPaise: 0, upiPaise: 0, cardPaise: 0, chequesPaise: 0, other: [], unvaluedProductIds: [], receivables: [], payables: [] });
  const bankId = (await createBankAccount(owner, { name: "Only Bank", statementBalance: "0", asOf: START })).id;
  const productId = (await createProduct(owner, { name: `Tap ${counter}`, sku: `ST-${counter}`, baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "500", wholesalePaise: "500", costPaise: "300" })).id;
  await recordOpeningStock(owner, { idempotencyKey: key(), movementDate: today, lines: [{ productId, unit: "pc", quantity: "100" }] });
  return { shop, owner, bankId, productId };
}
type World = Awaited<ReturnType<typeof setup>>;

async function sellUpi(w: World, rupees: string) {
  const input = { lines: [{ productId: w.productId, unit: "pc", quantity: String(Number(rupees) / 500) }], payments: { upi: rupees } };
  const preview = await previewBill(w.owner, input as never);
  return createInvoice(w.owner, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates } as never);
}
const net = async (w: World, systemKey: string) => {
  const row = (await accountBalances(w.owner)).find((entry) => entry.systemKey === systemKey);
  return (row?.debitPaise ?? 0) - (row?.creditPaise ?? 0);
};
async function statementLine(w: World, narration: string, credit: string) {
  await importStatement(w.owner, { bankAccountId: w.bankId, fileName: `${narration}.csv`, mapping: MAPPING, text: csv([[dmy(today), narration, "", credit, credit]]) });
  const bench = await bankWorkbench(w.owner, w.bankId, "open");
  return { lineId: bench.lines.find((line) => line.narration === narration)!.id, upiItems: bench.clearingItems.filter((item) => item.accountKey === "upi").map((item) => item.journalLineId) };
}

describe("a settlement arriving after the day was closed", () => {
  it("posts Dr Bank ₹495, Dr fee ₹5, Cr UPI ₹500 on the statement date without reopening the day or touching the closing", async () => {
    const w = await setup();
    await sellUpi(w, "500");
    await submitDrawerCount(w.owner, { idempotencyKey: key(), businessDate: today, counted: "1000", note: "Evening" });
    const book = await getCashbook(w.owner, today);
    await closeDay(w.owner, { businessDate: today, counted: String(book.expectedPaise / 100) });
    const closingBefore = (await db.owner.select().from(dayClosings).where(eq(dayClosings.shopId, w.shop.shopId)))[0]!;
    const countsBefore = await db.owner.select().from(drawerCounts).where(eq(drawerCounts.shopId, w.shop.shopId));
    const cashBefore = await net(w, "cash");
    const cashbookBefore = await getCashbook(w.owner, today);

    const { lineId, upiItems } = await statementLine(w, "UPI SETTLEMENT", "495.00");
    expect(upiItems).toHaveLength(1);
    const before = Date.now();
    const result = await confirmMatch(w.owner, { idempotencyKey: key(), bankAccountId: w.bankId, lineIds: [lineId], itemIds: upiItems });
    expect(result).toMatchObject({ kind: "settlement", feePaise: 500, replayed: false });

    // The journal: balanced, on the statement date, tied to the match group that holds the statement line.
    const [journal] = await db.owner.select().from(journals).where(and(eq(journals.shopId, w.shop.shopId), eq(journals.sourceId, result.groupId)));
    expect(journal).toMatchObject({ entryDate: today, sourceType: "bank_match_group", event: "bank_settlement" });
    expect(journal!.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000); // the real time it was reconciled
    const lines = await db.owner.execute<{ key: string; debit: string; credit: string }>(`select a.system_key as key, l.debit_paise::text as debit, l.credit_paise::text as credit from journal_lines l join accounts a on a.id = l.account_id where l.journal_id = '${journal!.id}' order by 1` as never);
    expect(lines.rows).toEqual([
      { key: "bank", debit: "49500", credit: "0" },
      { key: "bank_charges", debit: "500", credit: "0" },
      { key: "upi", debit: "0", credit: "50000" },
    ]);
    expect(await net(w, "upi")).toBe(0);

    // The audit trail says what happened, when, and that the day was already closed.
    const [audit] = await db.owner.select().from(auditLog).where(and(eq(auditLog.action, "bank.settled"), eq(auditLog.entityId, result.groupId)));
    expect(audit!.after).toMatchObject({ lineIds: [lineId], journalDate: today, statementDates: [today], postedOnClosedDay: true, feePaise: 500 });
    expect(typeof (audit!.after as { reconciledAt: string }).reconciledAt).toBe("string");

    // The closing, the drawer counts and the cash figures are exactly as they were; the day is still closed.
    expect((await db.owner.select().from(dayClosings).where(eq(dayClosings.shopId, w.shop.shopId)))[0]).toEqual(closingBefore);
    expect(await db.owner.select().from(drawerCounts).where(eq(drawerCounts.shopId, w.shop.shopId))).toEqual(countsBefore);
    expect(await net(w, "cash")).toBe(cashBefore);
    const cashbookAfter = await getCashbook(w.owner, today);
    expect(cashbookAfter).toMatchObject({ closed: true, expectedPaise: cashbookBefore.expectedPaise });
    expect(cashbookAfter.closing).toEqual(cashbookBefore.closing);
  });

  it("a retry never posts twice: the same key replays and a new key finds it already explained", async () => {
    const w = await setup();
    await sellUpi(w, "500");
    await closeDay(w.owner, { businessDate: today, counted: "1000" });
    const { lineId, upiItems } = await statementLine(w, "UPI SETTLEMENT", "495.00");
    const body = { idempotencyKey: key(), bankAccountId: w.bankId, lineIds: [lineId], itemIds: upiItems };
    const first = await confirmMatch(w.owner, body);
    const count = async () => (await db.owner.select().from(journals).where(and(eq(journals.shopId, w.shop.shopId), eq(journals.event, "bank_settlement")))).length;
    expect(await count()).toBe(1);
    const again = await confirmMatch(w.owner, body);
    expect(again).toMatchObject({ replayed: true, groupId: first.groupId });
    expect(await count()).toBe(1);
    expect((await refusal(confirmMatch(w.owner, { ...body, idempotencyKey: key() }))).code).toBeTruthy();
    expect(await count()).toBe(1);
    expect(await net(w, "bank_charges")).toBe(500);
  });

  it("still respects an accounting-period lock: nothing is posted before the books' lock date", async () => {
    const w = await setup();
    await sellUpi(w, "500");
    await closeDay(w.owner, { businessDate: today, counted: "1000" });
    await db.owner.update(accountingSettings).set({ lockThrough: today }).where(eq(accountingSettings.shopId, w.shop.shopId));
    const { lineId, upiItems } = await statementLine(w, "UPI SETTLEMENT", "495.00");
    const error = await refusal(confirmMatch(w.owner, { idempotencyKey: key(), bankAccountId: w.bankId, lineIds: [lineId], itemIds: upiItems }));
    expect(error.code).toBe("BOOKS_LOCKED");
    expect(await db.owner.select().from(journals).where(and(eq(journals.shopId, w.shop.shopId), eq(journals.event, "bank_settlement")))).toEqual([]);
    expect(await net(w, "upi")).toBe(50000); // nothing moved
  });

  it("every other money write stays blocked on the closed day", async () => {
    const w = await setup();
    const customerId = (await createCustomer(w.owner, { name: "Closed Day Buyer", phone: "9899000001", type: "retail", creditLimit: "100000" })).id;
    await closeDay(w.owner, { businessDate: today, counted: "1000" });
    const input = { lines: [{ productId: w.productId, unit: "pc", quantity: "1" }], payments: { cash: "500" } };
    const preview = await previewBill(w.owner, input as never);
    expect((await refusal(createInvoice(w.owner, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates } as never))).code).toBe("DAY_CLOSED");
    expect((await refusal(recordExpense(w.owner, { idempotencyKey: key(), businessDate: today, category: "tea", amount: "10", method: "cash" }))).code).toBe("DAY_CLOSED");
    expect((await refusal(recordCustomerReceipt(w.owner, { idempotencyKey: key(), customerId, amount: "10", method: "cash" }))).code).toBe("DAY_CLOSED");
    // A bank charge or interest line is not a settlement: it cannot be posted onto a closed day either.
    await importStatement(w.owner, { bankAccountId: w.bankId, fileName: "charge.csv", mapping: MAPPING, text: csv([[dmy(today), "SMS CHARGES", "20.00", "", "-20.00"]]) });
    const line = (await bankWorkbench(w.owner, w.bankId, "open")).lines.find((entry) => entry.narration === "SMS CHARGES")!;
    expect((await refusal(postLine(w.owner, { idempotencyKey: key(), lineId: line.id, kind: "bank_charge", confirm: true }))).code).toBe("DAY_CLOSED");
  });

  it("belongs to one shop: another shop's owner cannot settle these lines", async () => {
    const a = await setup();
    const b = await setup();
    await sellUpi(a, "500");
    await closeDay(a.owner, { businessDate: today, counted: "1000" });
    const { lineId, upiItems } = await statementLine(a, "UPI SETTLEMENT", "495.00");
    const error = await refusal(confirmMatch(b.owner, { idempotencyKey: key(), bankAccountId: a.bankId, lineIds: [lineId], itemIds: upiItems }));
    expect(error.code).toBeTruthy();
    expect(await net(a, "upi")).toBe(50000);
    expect((await db.owner.select().from(journalLines).where(eq(journalLines.shopId, b.shop.shopId))).length).toBeGreaterThan(0); // their own books are untouched by this attempt
  });
});
