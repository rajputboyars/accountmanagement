import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { accountBalances, activateBusinessAccounts, createBankAccount, moneyOverview, recordDerivedOpening, setBankAccountActive } from "@/modules/accounting";
import { journalLines, journals } from "@/modules/accounting/schema";
import { bankWorkbench, confirmMatch, importStatement } from "@/modules/banking";
import { recordCashMovement, recordExpense } from "@/modules/cashbook";
import { createProduct } from "@/modules/catalog";
import { createCustomer } from "@/modules/parties";
import { recordCustomerReceipt } from "@/modules/payments";
import { payments } from "@/modules/payments/schema";
import { createSupplier, createPurchaseReturn, getGoodsReceipt, paySupplier } from "@/modules/purchasing";
import { cancelInvoice, createInvoice, previewBill } from "@/modules/sales";
import { createReturn, getReturnableInvoice, previewReturn } from "@/modules/sales";
import { toActionError } from "@/server/action-result";
import { indiaDate } from "@/shared/financial-year";
import { addDays } from "@/shared/report-range";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { receiveGoods } from "../helpers/purchasing";
import { setupTestDatabase } from "../helpers/test-db";

/**
 * Two bank accounts: every workflow that moves money through a bank uses the account that was chosen, refunds go back out of the
 * account the money came into, cash-only workflows never ask, and the Money overview keeps pending UPI/card/cheque money apart.
 */
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
  return (await toActionError(error)).error;
};

let shop: TestShop;
let s: Session;
let first: string;
let second: string;
let secondKey: string;
let tap: string;
let customerId: string;
let supplierId: string;
let receiptId: string;

const net = async (systemKey: string) => {
  const row = (await accountBalances(s)).find((entry) => entry.systemKey === systemKey);
  return (row?.debitPaise ?? 0) - (row?.creditPaise ?? 0);
};
const journalCount = async () => (await db.owner.select().from(journals).where(eq(journals.shopId, shop.shopId))).length;
const paymentBy = async (reference: string) => (await db.owner.select().from(payments).where(eq(payments.reference, reference)))[0]!;
const sell = async (payments: Record<string, string>, extra: Record<string, unknown> = {}, quantity = "10") => {
  const input = { lines: [{ productId: tap, unit: "pc", quantity }], payments, ...extra };
  const preview = await previewBill(s, input as never);
  expect(preview.problems).toEqual([]);
  return createInvoice(s, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates } as never);
};

beforeAll(async () => {
  shop = await createTestShop(db, "Two banks routing");
  s = (await signInAs(shop.users.owner)).session;
  await activateBusinessAccounts(s, { coverageStartDate: START });
  await recordDerivedOpening(s, { cashPaise: 1000000, bankPaise: 0, upiPaise: 0, cardPaise: 0, chequesPaise: 0 });
  ({ id: tap } = await createProduct(s, { name: "Route tap", sku: "RT-1", baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "60" }));
  ({ id: customerId } = await createCustomer(s, { name: "Route Customer", phone: "9466000001", type: "retail", creditLimit: "1000000" }));
  ({ id: supplierId } = await createSupplier(s, { name: "Route Supplier", phone: "", gstin: "", paymentTermsDays: "30" }));
  ({ id: receiptId } = await receiveGoods(s, { idempotencyKey: key(), supplierId, supplierBillNo: "RT-1", supplierBillDate: today, lines: [{ productId: tap, unit: "pc", quantity: "200", cost: "60", gstRateBp: "0" }] }));
});

describe("one bank account: nothing changes, nothing is asked", () => {
  it("uses the only account without a choice, and cash needs none", async () => {
    await sell({ bank: "1000" });
    expect(await net("bank")).toBe(100000); // before any account is added, the original bank account
    ({ id: first } = await createBankAccount(s, { name: "First Bank", statementBalance: "0", asOf: START }));
    await sell({ bank: "1000" });
    expect(await net("bank")).toBe(200000);
    const [row] = (await db.owner.select().from(payments).where(eq(payments.method, "bank"))).filter((payment) => payment.bankAccountId === first);
    expect(row).toBeTruthy(); // saved against the only account, so its statement can match it
    await sell({ cash: "1000" });
    expect(await net("cash")).toBeGreaterThan(0);
  });
});

describe("two bank accounts: the chosen one is used everywhere", () => {
  beforeAll(async () => {
    ({ id: second } = await createBankAccount(s, { name: "Second Bank", statementBalance: "0", asOf: START }));
    secondKey = `bank:${second}`;
  });

  it("a bank amount on a bill needs a choice, and goes to the chosen account", async () => {
    const before = await journalCount();
    expect(await refusal(sell({ bank: "1000" }))).toMatch(/choose which bank account/i);
    expect(await journalCount()).toBe(before);
    await sell({ bank: "1000" }, { bankAccountId: second });
    expect(await net(secondKey)).toBe(100000);
    expect(await net("bank")).toBe(200000);
  });

  it("split payment: cash and UPI never ask, only the bank part uses the account", async () => {
    await sell({ cash: "300", upi: "300", bank: "400" }, { bankAccountId: first });
    expect(await net(secondKey)).toBe(100000);
    expect(await net("bank")).toBe(240000);
    expect(await net("upi")).toBe(30000);
  });

  it("cancelling a bill pays the money back out of the account it came into", async () => {
    const bill = await sell({ bank: "1000" }, { bankAccountId: second });
    expect(await net(secondKey)).toBe(200000);
    await cancelInvoice(s, bill.id, { reason: "Customer left" });
    expect(await net(secondKey)).toBe(100000);
    expect(await net("bank")).toBe(240000);
    const refund = (await db.owner.select().from(payments).where(eq(payments.invoiceId, bill.id))).find((payment) => payment.direction === "out");
    expect(refund).toMatchObject({ method: "bank", bankAccountId: second, amountPaise: 100000 });
  });

  it("a customer receipt, a supplier payment and its reversal follow the chosen account", async () => {
    await recordCustomerReceipt(s, { idempotencyKey: key(), customerId, amount: "700", method: "bank", reference: "R-2", bankAccountId: second });
    expect(await refusal(recordCustomerReceipt(s, { idempotencyKey: key(), customerId, amount: "10", method: "bank", reference: "R-X" }))).toMatch(/choose which bank account/i);
    expect(await net(secondKey)).toBe(170000);
    await paySupplier(s, { idempotencyKey: key(), supplierId, amount: "500", method: "bank", reference: "S-1", bankAccountId: first });
    expect(await net("bank")).toBe(240000 - 50000);
    expect((await paymentBy("S-1")).bankAccountId).toBe(first);
  });

  it("a credit-note refund by bank needs a choice and comes out of the chosen account", async () => {
    const bill = await sell({ bank: "1000" }, { bankAccountId: second });
    const [line] = (await getReturnableInvoice(s, bill.id)).lines;
    const draft = { invoiceId: bill.id, lines: [{ invoiceLineId: line!.id, baseQty: "2", restock: true }], reason: "Wrong size", settlement: "bank" as const };
    const total = (await previewReturn(s, draft)).totalPaise;
    expect(total).toBe(20000);
    expect(await refusal(createReturn(s, { ...draft, idempotencyKey: key(), expectedTotalPaise: total }))).toMatch(/choose which bank account/i);
    const before = await net(secondKey);
    await createReturn(s, { ...draft, bankAccountId: second, idempotencyKey: key(), expectedTotalPaise: total });
    expect(await net(secondKey)).toBe(before - 20000);
  });

  it("a supplier refund from a purchase return comes into the chosen account", async () => {
    const detail = await getGoodsReceipt(s, receiptId);
    const base = { idempotencyKey: key(), goodsReceiptId: receiptId, reason: "Wrong size", settlement: "refund", refundMethod: "bank", lines: [{ receiptLineId: detail.lines[0]!.id, quantity: "5" }] };
    expect(await refusal(createPurchaseReturn(s, base))).toMatch(/choose which bank account/i);
    const before = await net(secondKey);
    await createPurchaseReturn(s, { ...base, idempotencyKey: key(), bankAccountId: second });
    expect(await net(secondKey)).toBe(before + 30000);
    // A cash refund never asks.
    await createPurchaseReturn(s, { ...base, idempotencyKey: key(), refundMethod: "cash", lines: [{ receiptLineId: detail.lines[0]!.id, quantity: "1" }] });
  });

  it("an expense paid by bank and a cash deposit use the chosen account; cash-only entries never ask", async () => {
    expect(await refusal(recordExpense(s, { idempotencyKey: key(), businessDate: today, category: "transport", amount: "100", method: "bank" }))).toMatch(/choose which bank account/i);
    expect(await refusal(recordCashMovement(s, { idempotencyKey: key(), businessDate: today, kind: "bank_deposit", amount: "500" }))).toMatch(/choose which bank account/i);
    const secondBefore = await net(secondKey);
    const firstBefore = await net("bank");
    await recordExpense(s, { idempotencyKey: key(), businessDate: today, category: "transport", amount: "100", method: "bank", bankAccountId: second });
    await recordCashMovement(s, { idempotencyKey: key(), businessDate: today, kind: "bank_deposit", amount: "500", bankAccountId: first });
    expect(await net(secondKey)).toBe(secondBefore - 10000);
    expect(await net("bank")).toBe(firstBefore + 50000);
    // No bank involved: no question, and the choice sent anyway is ignored.
    await recordExpense(s, { idempotencyKey: key(), businessDate: today, category: "tea", amount: "20", method: "cash", bankAccountId: second });
    await recordCashMovement(s, { idempotencyKey: key(), businessDate: today, kind: "withdrawal", amount: "100", bankAccountId: second });
    expect(await net(secondKey)).toBe(secondBefore - 10000);
  });

  it("refuses a switched-off account", async () => {
    const { id: third } = await createBankAccount(s, { name: "Third Bank", statementBalance: "0", asOf: START });
    await setBankAccountActive(s, third, false);
    expect(await refusal(sell({ bank: "100" }, { bankAccountId: third }, "1"))).toMatch(/switched off/i);
  });
});

describe("integrity", () => {
  it("a retried bill with the same key posts once, and history never changes", async () => {
    const input = { lines: [{ productId: tap, unit: "pc", quantity: "1" }], payments: { bank: "100" }, bankAccountId: second };
    const preview = await previewBill(s, input as never);
    const body = { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates };
    const history = await db.owner.select().from(journalLines).where(eq(journalLines.shopId, shop.shopId));
    await createInvoice(s, body as never);
    const after = await journalCount();
    const again = await createInvoice(s, body as never);
    expect(again.replayed).toBe(true);
    expect(await journalCount()).toBe(after);
    const now = await db.owner.select().from(journalLines).where(eq(journalLines.shopId, shop.shopId));
    expect(now.slice(0, history.length)).toEqual(history); // earlier entries are untouched
  });

  it("every journal balances to the paisa, and the books' accounts add up", async () => {
    const lines = await db.owner.select().from(journalLines).where(eq(journalLines.shopId, shop.shopId));
    const byJournal = new Map<string, number>();
    for (const line of lines) byJournal.set(line.journalId, (byJournal.get(line.journalId) ?? 0) + line.debitPaise - line.creditPaise);
    expect([...byJournal.values()].filter((value) => value !== 0)).toEqual([]);
    const rows = await accountBalances(s);
    expect(rows.reduce((sum, row) => sum + row.debitPaise - row.creditPaise, 0)).toBe(0);
  });
});

describe("settlement batch with a fee on the second account, and the Money overview", () => {
  it("settles UPI into the chosen account less the fee, and the overview keeps pending money apart", async () => {
    await sell({ upi: "1000" });
    await sell({ upi: "2000" }, {}, "20");
    const upiBefore = await net("upi");
    expect(upiBefore).toBeGreaterThanOrEqual(300000);
    const awaitingBefore = (await moneyOverview(s, { from: START, to: today })).awaitingSettlementPaise;
    expect(awaitingBefore).toBe(upiBefore);

    const settleAmount = upiBefore - 6000;
    await importStatement(s, { bankAccountId: second, fileName: "b2.csv", mapping: MAPPING, text: csv([[dmy(today), "UPI SETTLEMENT BATCH", "", (settleAmount / 100).toFixed(2), "0.00"]]) });
    const bench = await bankWorkbench(s, second, "all");
    const lineId = bench.lines.find((line) => line.narration.startsWith("UPI SETTLEMENT"))!.id;
    const itemIds = bench.clearingItems.filter((item) => item.accountKey === "upi").map((item) => item.journalLineId);
    const secondBefore = await net(secondKey);
    const feesBefore = await net("bank_charges");
    const salesBefore = await net("sales");
    const result = await confirmMatch(s, { idempotencyKey: key(), bankAccountId: second, lineIds: [lineId], itemIds });
    expect(result).toMatchObject({ kind: "settlement", feePaise: 6000 });
    expect(await net(secondKey)).toBe(secondBefore + settleAmount);
    expect(await net("bank_charges")).toBe(feesBefore + 6000);
    expect(await net("sales")).toBe(salesBefore);
    expect(await net("upi")).toBe(0);
  });

  it("shows Cash and bank as cash plus the bank accounts only, with pending money listed apart", async () => {
    await sell({ card: "1000" });
    const overview = await moneyOverview(s, { from: START, to: today });
    const keys = overview.cashAndBank.map((row) => row.key);
    expect(keys).toEqual(expect.arrayContaining(["cash", "bank", secondKey]));
    expect(keys.some((k) => ["upi", "card", "cheques"].includes(k))).toBe(false);
    expect(overview.awaitingSettlement.map((row) => row.key)).toEqual(["card"]);
    // The totals agree with the underlying account balances.
    expect(overview.cashAndBankPaise).toBe((await net("cash")) + (await net("bank")) + (await net(secondKey)));
    expect(overview.awaitingSettlementPaise).toBe((await net("upi")) + (await net("card")) + (await net("cheques")));
    expect(overview.awaitingSettlementPaise).toBe(100000);
    expect(overview.cashAndBank.reduce((sum, row) => sum + row.amountPaise, 0)).toBe(overview.cashAndBankPaise);
  });
});
