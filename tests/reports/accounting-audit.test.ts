import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getCashbook, recordExpense, voidExpense } from "@/modules/cashbook";
import { createProduct } from "@/modules/catalog";
import { recordOpeningStock } from "@/modules/inventory";
import { partyBalance } from "@/modules/ledger";
import { createCustomer } from "@/modules/parties";
import { recordCustomerReceipt, reverseCustomerReceipt } from "@/modules/payments";
import { createSupplier, paySupplier, receiveGoods } from "@/modules/purchasing";
import { getDashboard, getReport } from "@/modules/reporting";
import { cancelInvoice, createInvoice, createReturn, getReturnableInvoice, previewBill, previewReturn, type BillInput } from "@/modules/sales";
import { NotFoundError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { addDays } from "@/shared/report-range";
import { createTestShop, signInAs } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

/**
 * One day of trading through every money path, then every view of it reconciled: billed vs received
 * vs owed, cash vs UPI vs card, the drawer, expenses, gross profit, the reports, Today vs a custom
 * range, and another shop seeing none of it.
 */
const db = setupTestDatabase();
type Session = Awaited<ReturnType<typeof signInAs>>["session"];
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
let n = 0;

async function sell(session: Session, input: BillInput) {
  const preview = await previewBill(session, input);
  return createInvoice(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}

async function tradingDay() {
  n += 1;
  const shop = await createTestShop(db, `Accounts audit ${n}`);
  const session = (await signInAs(shop.users.owner)).session;
  // ₹100 a piece, no GST, cost ₹60.
  const { id: tap } = await createProduct(session, { name: `Tap ${n}`, sku: `AA-${n}`, baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "60" });
  await recordOpeningStock(session, { idempotencyKey: key(), movementDate: today, lines: [{ productId: tap, unit: "pc", quantity: "100" }] });
  const { id: buyer } = await createCustomer(session, { name: `Buyer ${n}`, phone: String(9800000000 + n), type: "retail", creditLimit: "100000" });

  const cashBill = await sell(session, { lines: [{ productId: tap, unit: "pc", quantity: "5" }], payments: { cash: "500" } });
  await sell(session, { lines: [{ productId: tap, unit: "pc", quantity: "3" }], payments: { upi: "300" } });
  await sell(session, { lines: [{ productId: tap, unit: "pc", quantity: "2" }], payments: { card: "200" } });
  await sell(session, { customerId: buyer, lines: [{ productId: tap, unit: "pc", quantity: "10" }], payments: { cash: "400" } }); // ₹600 on credit
  await recordCustomerReceipt(session, { idempotencyKey: key(), customerId: buyer, amount: "200", method: "upi", reference: `UTR-AA-${n}` });
  const mistake = await recordCustomerReceipt(session, { idempotencyKey: key(), customerId: buyer, amount: "100", method: "cash" });
  await reverseCustomerReceipt(session, mistake.id, { reason: "Entered twice" });
  const cancelled = await sell(session, { lines: [{ productId: tap, unit: "pc", quantity: "3" }], payments: { cash: "300" } });
  await cancelInvoice(session, cancelled.id, { reason: "Customer left" });
  const [line] = (await getReturnableInvoice(session, cashBill.id)).lines;
  const ret = { invoiceId: cashBill.id, lines: [{ invoiceLineId: line!.id, baseQty: "2", restock: true }], reason: "Extra", settlement: "cash" as const };
  await createReturn(session, { ...ret, idempotencyKey: key(), expectedTotalPaise: (await previewReturn(session, ret)).totalPaise });

  const expenseKey = key();
  await Promise.all([recordExpense(session, { idempotencyKey: expenseKey, businessDate: today, category: "tea", amount: "150", method: "cash" }), recordExpense(session, { idempotencyKey: expenseKey, businessDate: today, category: "tea", amount: "150", method: "cash" })]);
  const upiExpense = await recordExpense(session, { idempotencyKey: key(), businessDate: today, category: "transport", amount: "250", method: "upi" });
  await voidExpense(session, upiExpense.id, { reason: "Wrong shop" });

  const { id: supplier } = await createSupplier(session, { name: `Supplier ${n}`, phone: "9000006006", paymentTermsDays: "30" });
  await receiveGoods(session, { idempotencyKey: key(), supplierId: supplier, lines: [{ productId: tap, unit: "pc", quantity: "50", cost: "60", gstRateBp: "0" }] });
  await paySupplier(session, { idempotencyKey: key(), supplierId: supplier, amount: "1000", method: "cash" });
  await paySupplier(session, { idempotencyKey: key(), supplierId: supplier, amount: "500", method: "upi", reference: `UTR-SUP-${n}` });
  return { shop, session, tap, buyer, supplier, upiExpense };
}

describe("expenses, cash flow and profit audit", () => {
  it("keeps billed, received, owed, cash and profit apart and each one right", async () => {
    const { session, buyer, supplier, upiExpense } = await tradingDay();
    const dash = await getDashboard(session);

    // Billed: the four kept bills; the cancelled one is not a sale. ₹600 of it is credit, not cash.
    expect(dash.sales).toMatchObject({ billCount: 4, billedPaise: 200000, paidAtCounterPaise: 140000, creditGivenPaise: 60000, cancelledCount: 1 });
    // Received: ₹1,400 on bills + ₹300 on the bill later cancelled + ₹300 of dues − ₹100 reversed = ₹1,900.
    // Money that went back (₹300 cancelled + ₹200 returned) is shown as refunds, not netted silently.
    expect(dash.money).toMatchObject({ collectedPaise: 190000, oldDuesPaise: 20000, reversedPaise: 10000, refundsPaise: 50000, supplierPaidPaise: 150000 });
    expect(dash.money.split).toEqual({ cashPaise: 120000, upiPaise: 50000, otherPaise: 20000 });
    // Owed: ₹1,000 − ₹400 − ₹200 − ₹100 + ₹100 (reversal) = ₹400; the supplier is owed ₹3,000 − ₹1,500.
    expect(await partyBalance(session.shopId, "customer", buyer)).toBe(40000);
    expect(dash.receivables?.receivablePaise).toBe(40000);
    expect(dash.payables?.payablePaise).toBe(150000);
    // Expenses: the UPI one was voided, once; voiding again is refused.
    expect(dash.expenses).toMatchObject({ totalPaise: 15000, byCategory: [{ key: "tea", totalPaise: 15000 }] });
    await expect(voidExpense(session, upiExpense.id, { reason: "Again" })).rejects.toBeTruthy();
    // Drawer: ₹1,200 cash in on bills, ₹100 receipt in and reversed, ₹500 cash refunds, ₹1,000 to the supplier, ₹150 tea.
    expect(dash.cash?.netCashPaise).toBe(120000 - 50000 - 100000 - 15000);
    const book = await getCashbook(session, today);
    expect(book.expectedPaise - book.cash.openingPaise).toBe(dash.cash?.netCashPaise);
    expect(book.cash.cashExpensesPaise).toBe(15000); // the voided UPI expense never touched the drawer
    // Gross profit (before GST): ₹2,000 − ₹200 returned, cost 20 × ₹60 − 2 restocked × ₹60. Expenses are separate.
    expect(dash.profit).toEqual({ reliable: true, revenuePaise: 180000, costPaise: 108000, grossProfitPaise: 72000 });
    expect(supplier).toBeTruthy();
  });

  it("gives the same totals in the reports, and for Today and a custom range", async () => {
    const { session } = await tradingDay();
    const dash = await getDashboard(session);
    const sales = await getReport(session, "sales");
    expect(sales.totals).toEqual({ total: dash.sales.billedPaise, paid: dash.sales.paidAtCounterPaise, credit: dash.sales.creditGivenPaise });
    expect((await getReport(session, "collections")).totals.amount).toBe(dash.money.collectedPaise);
    expect((await getReport(session, "expenses")).totals.amount).toBe(dash.expenses.totalPaise);
    expect((await getReport(session, "returns")).totals.total).toBe(dash.sales.creditNotesPaise);

    const custom = await getDashboard(session, { range: "custom", from: today, to: today });
    expect({ sales: custom.sales, money: custom.money, expenses: custom.expenses, cash: custom.cash, profit: custom.profit }).toEqual({ sales: dash.sales, money: dash.money, expenses: dash.expenses, cash: dash.cash, profit: dash.profit });
    const yesterday = await getDashboard(session, { range: "custom", from: addDays(today, -1), to: addDays(today, -1) });
    expect(yesterday.sales.billedPaise).toBe(0);
    expect(yesterday.money.collectedPaise).toBe(0);
    expect(yesterday.expenses.totalPaise).toBe(0);
  });

  it("shows profit as unavailable once any sold item has no cost, instead of guessing", async () => {
    const { session } = await tradingDay();
    const { id: noCost } = await createProduct(session, { name: `No cost ${n}`, sku: `NC-${n}`, baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "50", wholesalePaise: "45", costPaise: "" });
    await recordOpeningStock(session, { idempotencyKey: key(), movementDate: today, lines: [{ productId: noCost, unit: "pc", quantity: "5" }] });
    await sell(session, { lines: [{ productId: noCost, unit: "pc", quantity: "1" }], payments: { cash: "50" } });
    const profit = (await getDashboard(session)).profit;
    expect(profit).toMatchObject({ reliable: false, missingCostLines: 1 });
    expect(profit).not.toHaveProperty("grossProfitPaise");
  });

  it("refuses bad expense amounts, saves a repeated expense once, and keeps shops apart", async () => {
    const { session, upiExpense } = await tradingDay();
    for (const amount of ["0", "-5", "12.345", "abc"]) {
      await expect(recordExpense(session, { idempotencyKey: key(), businessDate: today, category: "tea", amount, method: "cash" }), amount).rejects.toBeTruthy();
    }
    expect((await getDashboard(session)).expenses.totalPaise).toBe(15000); // the double-submitted ₹150 counted once
    n += 1;
    const other = await createTestShop(db, `Accounts other ${n}`);
    const outsider = (await signInAs(other.users.owner)).session;
    const theirs = await getDashboard(outsider);
    expect(theirs.sales.billedPaise).toBe(0);
    expect(theirs.money.collectedPaise).toBe(0);
    expect(theirs.expenses.totalPaise).toBe(0);
    expect(theirs.cash?.netCashPaise).toBe(0);
    await expect(voidExpense(outsider, upiExpense.id, { reason: "Not mine" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await getReport(outsider, "expenses")).rows).toEqual([]);
  });
});
