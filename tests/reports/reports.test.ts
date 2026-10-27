import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { recordExpense } from "@/modules/cashbook";
import { createProduct } from "@/modules/catalog";
import { recordOpeningStock } from "@/modules/inventory";
import { partyBalance, partyStatement, partyStatements } from "@/modules/ledger";
import { rolePermissions } from "@/modules/identity/schema";
import { createCustomer } from "@/modules/parties";
import { recordCustomerReceipt, reverseCustomerReceipt } from "@/modules/payments";
import { getDashboard, getReport, reportToCsv } from "@/modules/reporting";
import { listReceivables } from "@/modules/reporting/accounts";
import { createInvoice, createReturn, getReturnableInvoice, previewBill, previewReturn, type BillInput } from "@/modules/sales";
import { invoices } from "@/modules/sales/schema";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { createTestShop, signInAs } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
type Session = Awaited<ReturnType<typeof signInAs>>["session"];
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
const daysAgo = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

let n = 0;
async function setup(options: { cost?: string } = {}) {
  n += 1;
  const shop = await createTestShop(db, `Reports ${n}`);
  const session = (await signInAs(shop.users.owner)).session;
  // ₹100 a piece, no GST, so billed amounts are easy to read.
  const { id: productId } = await createProduct(session, { name: `Tap ${n}`, sku: `TP-${n}`, baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: options.cost ?? "70" });
  await recordOpeningStock(session, { idempotencyKey: key(), movementDate: today, lines: [{ productId, unit: "pc", quantity: "1000" }] });
  return { shop, session, productId };
}

async function sell(session: Session, input: BillInput) {
  const preview = await previewBill(session, input);
  return createInvoice(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}

const customer = (session: Session, extra: Record<string, unknown> = {}) =>
  createCustomer(session, { name: `Customer ${++n}`, phone: String(9200000000 + n), type: "retail", creditLimit: "1000000", ...extra }).then((result) => result.id);

describe("owner dashboard", () => {
  it("keeps billed sales, credit, collections, refunds, expenses and cash apart", async () => {
    const { session, productId } = await setup();
    const buyer = await customer(session);
    // ₹5,000 bill, ₹2,000 paid in cash now (part payment) → ₹3,000 on credit.
    await sell(session, { customerId: buyer, lines: [{ productId, unit: "pc", quantity: "50" }], payments: { cash: "2000" } });
    // ₹1,000 bill paid in full by UPI.
    const paid = await sell(session, { customerId: buyer, lines: [{ productId, unit: "pc", quantity: "10" }], payments: { upi: "1000" } });
    // ₹1,000 of old dues in cash, then a ₹500 cash refund on a return of 5 pieces.
    await recordCustomerReceipt(session, { idempotencyKey: key(), customerId: buyer, amount: "1000", method: "cash" });
    const [lineId] = (await getReturnableInvoice(session, paid.id)).lines.map((line) => line.id);
    const ret = { invoiceId: paid.id, lines: [{ invoiceLineId: lineId!, baseQty: "5", restock: true }], reason: "Extra", settlement: "cash" as const };
    await createReturn(session, { ...ret, idempotencyKey: key(), expectedTotalPaise: (await previewReturn(session, ret)).totalPaise });
    await recordExpense(session, { idempotencyKey: key(), businessDate: today, category: "tea", amount: "300", method: "cash" });

    const dash = await getDashboard(session);
    expect(dash.range).toMatchObject({ preset: "today", from: today, to: today });
    expect(dash.sales).toMatchObject({ billCount: 2, billedPaise: 600000, paidAtCounterPaise: 300000, creditGivenPaise: 300000, creditNotesPaise: 50000, refundedNotesPaise: 50000, adjustedNotesPaise: 0 });
    expect(dash.money).toMatchObject({ collectedPaise: 400000, onBillsPaise: 300000, oldDuesPaise: 100000, refundsPaise: 50000, reversedPaise: 0 });
    expect(dash.money.byMethod).toEqual({ cash: 300000, upi: 100000 });
    expect(dash.expenses).toMatchObject({ totalPaise: 30000, byCategory: [{ key: "tea", totalPaise: 30000 }] });
    // Cash: ₹2,000 + ₹1,000 in, ₹500 refund + ₹300 tea out → +₹2,200. Sales of ₹6,000 are not cash.
    expect(dash.cash).toEqual({ inPaise: 300000, outPaise: 80000, netCashPaise: 220000 });
    // Receivables come from the ledger: ₹3,000 credit − ₹1,000 received.
    expect(dash.receivables?.receivablePaise).toBe(200000);
    expect(dash.receivables?.receivablePaise).toBe(await partyBalance(session.shopId, "customer", buyer));
    // Profit: taxable ₹6,000 − ₹500 returned; cost 60 × ₹70 − 5 restocked × ₹70.
    expect(dash.profit).toEqual({ reliable: true, revenuePaise: 550000, costPaise: 385000, grossProfitPaise: 165000 });
    expect(dash.topProducts[0]).toMatchObject({ productId, baseQty: "60.000", valuePaise: 600000, billCount: 2 });
    expect(dash.trend.points).toHaveLength(7);
    expect(dash.trend.points.at(-1)).toMatchObject({ key: today, billedPaise: 600000, collectedPaise: 400000 });
    expect(dash.recent.length).toBeGreaterThan(0);
  });

  it("nets a reversed receipt off collections instead of calling it a refund", async () => {
    const { session } = await setup();
    const buyer = await customer(session, { openingOwed: "5000" });
    const receipt = await recordCustomerReceipt(session, { idempotencyKey: key(), customerId: buyer, amount: "2000", method: "upi", reference: "UTR-R1" });
    await reverseCustomerReceipt(session, receipt.id, { reason: "Entered twice" });
    const dash = await getDashboard(session);
    expect(dash.money).toMatchObject({ collectedPaise: 0, reversedPaise: 200000, refundsPaise: 0 });
    expect(dash.receivables?.receivablePaise).toBe(500000);
  });

  it("shows profit as unavailable, with the reason, when a sold item has no cost", async () => {
    const { session } = await setup();
    const { id: noCost } = await createProduct(session, { name: "Mystery valve", sku: `MV-${n}`, baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "50", wholesalePaise: "45", costPaise: "" });
    await recordOpeningStock(session, { idempotencyKey: key(), movementDate: today, lines: [{ productId: noCost, unit: "pc", quantity: "10" }] });
    const buyer = await customer(session);
    await sell(session, { customerId: buyer, lines: [{ productId: noCost, unit: "pc", quantity: "2" }] });
    const dash = await getDashboard(session);
    expect(dash.profit).toMatchObject({ reliable: false, missingCostLines: 1, missingProducts: ["Mystery valve"] });
    expect(dash.profit && !dash.profit.reliable && dash.profit.reason).toContain("Profit unavailable");
    expect(dash.profit).not.toHaveProperty("grossProfitPaise");
  });

  it("respects date boundaries: today, yesterday, 7 days and custom ranges", async () => {
    const { session, productId } = await setup();
    const buyer = await customer(session);
    const old = await sell(session, { customerId: buyer, lines: [{ productId, unit: "pc", quantity: "1" }] });
    const edge = await sell(session, { customerId: buyer, lines: [{ productId, unit: "pc", quantity: "2" }] });
    await sell(session, { customerId: buyer, lines: [{ productId, unit: "pc", quantity: "4" }] });
    // Test-only: move two bills into the past (bills are always dated today by the app).
    await db.owner.update(invoices).set({ businessDate: daysAgo(7) }).where(eq(invoices.id, old.id));
    await db.owner.update(invoices).set({ businessDate: daysAgo(6) }).where(eq(invoices.id, edge.id));
    const billed = async (input: Record<string, string>) => (await getDashboard(session, input)).sales.billedPaise;
    expect(await billed({ range: "today" })).toBe(40000);
    expect(await billed({ range: "yesterday" })).toBe(0);
    expect(await billed({ range: "7d" })).toBe(60000);
    expect(await billed({ range: "custom", from: daysAgo(7), to: daysAgo(6) })).toBe(30000);
    expect(await billed({ range: "custom", from: daysAgo(7), to: daysAgo(7) })).toBe(10000);
    const future = await getDashboard(session, { range: "custom", from: today, to: "2999-01-01" });
    expect(future.range).toMatchObject({ preset: "today", problem: "The range can't end in the future." });
    const sales = await getReport(session, "sales", { range: "7d" });
    expect(sales.rows.map((row) => row.cells.total)).toEqual([40000, 20000]);
    expect(sales.totals).toMatchObject({ total: 60000, paid: 0, credit: 60000 });
  });

  it("is role-aware: the owner sees profit, a manager doesn't, a cashier can't open reports", async () => {
    const { shop, session, productId } = await setup();
    const buyer = await customer(session);
    await sell(session, { customerId: buyer, lines: [{ productId, unit: "pc", quantity: "1" }] });
    const manager = (await signInAs(shop.users.manager)).session;
    const dash = await getDashboard(manager);
    expect(dash.profit).toBeNull();
    expect(dash.sales.billedPaise).toBe(10000);
    expect(dash.receivables).not.toBeNull();
    await expect(getDashboard((await signInAs(shop.users.cashier)).session)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getReport((await signInAs(shop.users.inventory)).session, "stock")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getReport(session, "nope")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("labels recent activity with the right party names and follows a revoked grant on the next load", async () => {
    const { shop, session, productId } = await setup();
    const buyer = await customer(session);
    await sell(session, { customerId: buyer, lines: [{ productId, unit: "pc", quantity: "1" }], payments: { cash: "100" } });
    await sell(session, { lines: [{ productId, unit: "pc", quantity: "1" }], payments: { cash: "100" } }); // walk-in
    const labels = (await getDashboard(session)).recent.map((row) => row.label);
    expect(labels.some((label) => label.endsWith(`· Customer ${n}`))).toBe(true);
    expect(labels.some((label) => label.endsWith("· Walk-in customer"))).toBe(true);
    // Permissions are read fresh on every load, never cached: the manager loses dues the moment it is revoked.
    const manager = (await signInAs(shop.users.manager)).session;
    expect((await getDashboard(manager)).receivables).not.toBeNull();
    await db.owner.update(rolePermissions).set({ allowed: false }).where(and(eq(rolePermissions.shopId, shop.shopId), eq(rolePermissions.role, "manager"), eq(rolePermissions.permission, "customers.view")));
    const after = await getDashboard(manager);
    expect(after.receivables).toBeNull();
    expect(after.alerts.receivables).toBeNull();
  });

  it("works out every customer's dues from one ledger query, matching each customer's own statement", async () => {
    const { session, productId } = await setup();
    const ids = [await customer(session, { openingOwed: "700", oldestBillDate: daysAgo(40) }), await customer(session), await customer(session, { openingOwed: "50" })];
    await sell(session, { customerId: ids[1]!, lines: [{ productId, unit: "pc", quantity: "3" }] });
    await recordCustomerReceipt(session, { idempotencyKey: key(), customerId: ids[0]!, amount: "200", method: "cash" });
    const statements = await partyStatements(session.shopId, "customer");
    for (const id of ids) expect(statements.get(id) ?? []).toEqual(await partyStatement(session.shopId, "customer", id));
    for (const id of ids) expect((await listReceivables(session)).rows.find((row) => row.id === id)?.balancePaise).toBe(await partyBalance(session.shopId, "customer", id));
    // No query per customer: ten more customers with dues cost no extra round trips.
    const queries = async () => {
      let count = 0;
      const query = pg.Client.prototype.query;
      pg.Client.prototype.query = function (this: pg.Client, ...args: Parameters<typeof query>) { count += 1; return query.apply(this, args); } as typeof query;
      try { await listReceivables(session); } finally { pg.Client.prototype.query = query; }
      return count;
    };
    const before = await queries();
    for (let i = 0; i < 10; i++) await customer(session, { openingOwed: "10" });
    expect(await queries()).toBe(before);
  });

  it("never shows another shop's records", async () => {
    const a = await setup();
    const b = await setup();
    const buyer = await customer(a.session, { openingOwed: "900" });
    await sell(a.session, { customerId: buyer, lines: [{ productId: a.productId, unit: "pc", quantity: "3" }] });
    const dash = await getDashboard(b.session);
    expect(dash.sales.billedPaise).toBe(0);
    expect(dash.money.collectedPaise).toBe(0);
    expect(dash.receivables?.receivablePaise).toBe(0);
    expect(dash.topProducts).toEqual([]);
    expect((await getReport(b.session, "sales")).rows).toEqual([]);
    expect((await getReport(b.session, "customer-dues")).rows).toEqual([]);
  });

  it("exports report rows as formula-safe CSV", async () => {
    const { session, productId } = await setup();
    const buyer = await customer(session, { name: "=HYPERLINK(\"http://x\")" });
    await sell(session, { customerId: buyer, lines: [{ productId, unit: "pc", quantity: "1" }] });
    const report = await getReport(session, "customer-dues");
    expect(report.rows[0]?.cells).toMatchObject({ name: "=HYPERLINK(\"http://x\")", balance: 10000 });
    const csv = reportToCsv(report);
    expect(csv.split("\r\n")[1]).toContain(`"100.00"`);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).not.toMatch(/(^|,)"=/m);
    const stock = await getReport(session, "stock");
    expect(stock.rows).toEqual([]);
  });
});
