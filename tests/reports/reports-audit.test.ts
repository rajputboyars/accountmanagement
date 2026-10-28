import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { recordExpense, voidExpense } from "@/modules/cashbook";
import { createProduct } from "@/modules/catalog";
import { recordOpeningStock } from "@/modules/inventory";
import { createCustomer } from "@/modules/parties";
import { recordCustomerReceipt } from "@/modules/payments";
import { cancelGoodsReceipt, createSupplier, paySupplier, receiveGoods } from "@/modules/purchasing";
import { getCustomerAccount, getDashboard, getReport, getSupplierStatement, reportToCsv } from "@/modules/reporting";
import { createInvoice, previewBill, type BillInput } from "@/modules/sales";
import { ForbiddenError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { addDays } from "@/shared/report-range";
import { createTestShop, signInAs } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

/**
 * Reports against the same records: date ranges include exactly the right days, statements and dues
 * reports agree, cut-off reports never show a partial total, and only the right roles and shop see them.
 */
const db = setupTestDatabase();
type Session = Awaited<ReturnType<typeof signInAs>>["session"];
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
const yesterday = addDays(today, -1);
let n = 0;

async function setup() {
  n += 1;
  const shop = await createTestShop(db, `Reports audit ${n}`);
  const session = (await signInAs(shop.users.owner)).session;
  const { id: productId } = await createProduct(session, { name: `Tap ${n}`, sku: `RA-${n}`, baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "60" });
  await recordOpeningStock(session, { idempotencyKey: key(), movementDate: today, lines: [{ productId, unit: "pc", quantity: "500" }] });
  return { shop, session, productId };
}
async function sell(session: Session, input: BillInput) {
  const preview = await previewBill(session, input);
  return createInvoice(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}
/** Test fixture only: move a bill and its counter payment to another business date. */
async function backdate(invoiceId: string, date: string) {
  await db.owner.execute(`update invoices set business_date = '${date}' where id = '${invoiceId}'`);
  await db.owner.execute(`update payments set business_date = '${date}' where invoice_id = '${invoiceId}'`);
}

describe("reports audit", () => {
  it("includes exactly the intended days for Today, Yesterday, 7 days, This month and inclusive custom ranges", async () => {
    const { session, productId } = await setup();
    const old = await sell(session, { lines: [{ productId, unit: "pc", quantity: "2" }], payments: { cash: "200" } });
    await backdate(old.id, yesterday);
    const ancient = await sell(session, { lines: [{ productId, unit: "pc", quantity: "4" }], payments: { cash: "400" } });
    await backdate(ancient.id, addDays(today, -40));
    await sell(session, { lines: [{ productId, unit: "pc", quantity: "1" }], payments: { cash: "100" } });
    await recordExpense(session, { idempotencyKey: key(), businessDate: yesterday, category: "tea", amount: "30", method: "cash" });

    const billed = async (input: Record<string, string>) => (await getDashboard(session, input)).sales.billedPaise;
    expect(await billed({})).toBe(10000);
    expect(await billed({ range: "yesterday" })).toBe(20000);
    expect(await billed({ range: "7d" })).toBe(30000);
    const monthStart = `${today.slice(0, 8)}01`;
    const expectedMonth = 10000 + (yesterday >= monthStart ? 20000 : 0);
    expect(await billed({ range: "month" })).toBe(expectedMonth);
    expect(await billed({ range: "custom", from: addDays(today, -40), to: addDays(today, -40) })).toBe(40000); // single day, inclusive
    expect(await billed({ range: "custom", from: addDays(today, -40), to: today })).toBe(70000); // both ends included
    expect(await billed({ range: "custom", from: addDays(today, -39), to: addDays(today, -2) })).toBe(0); // the gap between
    // The sales report and money report use the same days as the dashboard.
    const custom = { range: "custom", from: yesterday, to: yesterday };
    expect((await getReport(session, "sales", custom)).totals.total).toBe(20000);
    expect((await getReport(session, "collections", custom)).totals.amount).toBe(20000);
    expect((await getReport(session, "expenses", custom)).totals.amount).toBe(3000);
    expect((await getReport(session, "expenses")).totals.amount).toBe(0); // the expense was yesterday, not today
    // A bad custom range falls back to Today and says why, instead of guessing.
    const future = await getReport(session, "sales", { range: "custom", from: today, to: addDays(today, 3) });
    expect(future.range).toMatchObject({ preset: "today", problem: expect.stringContaining("future") });
  });

  it("agrees between statements, dues reports and the dashboard, including advances", async () => {
    const { session, productId } = await setup();
    const { id: buyer } = await createCustomer(session, { name: `Buyer ${n}`, phone: String(9810000000 + n), type: "retail", creditLimit: "100000" });
    const { id: advance } = await createCustomer(session, { name: `Advance ${n}`, phone: String(9820000000 + n), type: "retail", creditLimit: "100000", openingAdvance: "250" });
    await sell(session, { customerId: buyer, lines: [{ productId, unit: "pc", quantity: "10" }], payments: { cash: "300" } });
    await recordCustomerReceipt(session, { idempotencyKey: key(), customerId: buyer, amount: "200", method: "upi", reference: `UTR-RA-${n}` });

    const dues = await getReport(session, "customer-dues");
    const row = (id: string) => dues.rows.find((r) => r.id === id)?.cells.balance;
    expect(row(buyer)).toBe((await getCustomerAccount(session, buyer)).balancePaise);
    expect(row(advance)).toBe(-25000);
    const dash = await getDashboard(session);
    expect(dash.receivables).toMatchObject({ receivablePaise: 50000, advancesPaise: 25000 });
    expect(dues.totals.balance).toBe(dash.receivables!.receivablePaise - dash.receivables!.advancesPaise); // net, as the report says

    const { id: supplier } = await createSupplier(session, { name: `Supplier ${n}`, phone: "9000007007", paymentTermsDays: "30" });
    await receiveGoods(session, { idempotencyKey: key(), supplierId: supplier, lines: [{ productId, unit: "pc", quantity: "20", cost: "60", gstRateBp: "0" }] });
    await paySupplier(session, { idempotencyKey: key(), supplierId: supplier, amount: "500", method: "cash" });
    const supplierDues = await getReport(session, "supplier-dues");
    expect(supplierDues.rows.find((r) => r.id === supplier)?.cells.owed).toBe((await getSupplierStatement(session, supplier)).owedPaise);
    expect(supplierDues.totals.owed).toBe((await getDashboard(session)).payables?.payablePaise);
    // A supplier holding an advance (a part-paid receipt cancelled) shows as negative, like a customer advance.
    const { id: refundDue } = await createSupplier(session, { name: `Advance supplier ${n}`, phone: "9000009009", paymentTermsDays: "30" });
    const wrong = await receiveGoods(session, { idempotencyKey: key(), supplierId: refundDue, lines: [{ productId, unit: "pc", quantity: "10", cost: "60", gstRateBp: "0" }] });
    await paySupplier(session, { idempotencyKey: key(), supplierId: refundDue, amount: "100", method: "cash" });
    await cancelGoodsReceipt(session, wrong.id, { reason: "Sent back" });
    const withAdvance = await getReport(session, "supplier-dues");
    expect(withAdvance.rows.find((r) => r.id === refundDue)?.cells.owed).toBe(-10000);
    expect(withAdvance.totals.owed).toBe(withAdvance.rows.reduce((sum, r) => sum + Number(r.cells.owed), 0));
    expect(withAdvance.description).toContain("Negative");
  });

  it("never shows a partial total when a report is cut off, and says so in the CSV", async () => {
    const { session, productId } = await setup();
    for (let i = 0; i < 3; i++) await sell(session, { lines: [{ productId, unit: "pc", quantity: "1" }], payments: { cash: "100" } });
    const cut = await getReport(session, "sales", {}, { limit: 2 });
    expect(cut).toMatchObject({ truncated: true, totals: {} });
    expect(cut.rows).toHaveLength(2);
    const csv = reportToCsv(cut);
    expect(csv).toContain("Only the first 2 rows");
    expect(csv).not.toMatch(/^"?Total/m);
    const full = await getReport(session, "sales");
    expect(full.totals.total).toBe(30000);
    expect(reportToCsv(full)).toMatch(/^"Total",.*"300\.00"/m);
  });

  it("leaves out voided expenses and cancelled purchases, and shows clear zeros for an empty period", async () => {
    const { session, productId } = await setup();
    const kept = await recordExpense(session, { idempotencyKey: key(), businessDate: today, category: "tea", amount: "40", method: "cash" });
    const voided = await recordExpense(session, { idempotencyKey: key(), businessDate: today, category: "transport", amount: "90", method: "upi" });
    await voidExpense(session, voided.id, { reason: "Typed twice" });
    const expenses = await getReport(session, "expenses");
    expect(expenses.rows.map((r) => r.cells.status).sort()).toEqual(["Recorded", "Voided"]); // listed, marked
    expect(expenses.totals.amount).toBe(4000); // but not added up
    expect(kept.id).toBeTruthy();
    const { id: supplier } = await createSupplier(session, { name: `Supplier ${n}`, phone: "9000008008", paymentTermsDays: "30" });
    const receipt = await receiveGoods(session, { idempotencyKey: key(), supplierId: supplier, lines: [{ productId, unit: "pc", quantity: "5", cost: "60", gstRateBp: "0" }] });
    await cancelGoodsReceipt(session, receipt.id, { reason: "Wrong supplier" });
    expect((await getDashboard(session)).purchases).toEqual({ receiptCount: 0, receivedPaise: 0 });

    const empty = await getDashboard(session, { range: "yesterday" });
    expect(empty.sales).toMatchObject({ billCount: 0, billedPaise: 0 });
    expect(empty.money).toMatchObject({ collectedPaise: 0, refundsPaise: 0 });
    expect(empty.expenses.totalPaise).toBe(0);
    expect(empty.profit).toMatchObject({ reliable: true, revenuePaise: 0, costPaise: 0, grossProfitPaise: 0 });
    for (const kind of ["sales", "collections", "returns", "expenses"]) {
      const report = await getReport(session, kind, { range: "yesterday" });
      expect(report.rows, kind).toEqual([]);
      expect(Object.values(report.totals).every((value) => value === 0), kind).toBe(true);
    }
  });

  it("shows reports only to roles allowed to see them, and only for their own shop", async () => {
    const a = await setup();
    const b = await setup();
    await sell(a.session, { lines: [{ productId: a.productId, unit: "pc", quantity: "3" }], payments: { cash: "300" } });
    const cashier = (await signInAs(a.shop.users.cashier)).session;
    const inventory = (await signInAs(a.shop.users.inventory)).session;
    const manager = (await signInAs(a.shop.users.manager)).session;
    await expect(getReport(cashier, "sales")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getReport(inventory, "stock")).rejects.toBeInstanceOf(ForbiddenError); // no reports.view
    expect((await getReport(manager, "sales")).totals.total).toBe(30000);
    expect((await getDashboard(manager)).profit).toBeNull(); // profit is owner-only by default
    for (const kind of ["sales", "collections", "expenses", "returns", "customer-dues", "supplier-dues", "stock"]) {
      expect((await getReport(b.session, kind)).rows, kind).toEqual([]);
    }
  });
});
