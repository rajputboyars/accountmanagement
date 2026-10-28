import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createProduct } from "@/modules/catalog";
import { recordOpeningStock } from "@/modules/inventory";
import { partyBalance } from "@/modules/ledger";
import { createCustomer } from "@/modules/parties";
import { recordCustomerReceipt } from "@/modules/payments";
import { getDashboard, pendingCollections } from "@/modules/reporting";
import { createInvoice, previewBill, type BillInput } from "@/modules/sales";
import { indiaDate } from "@/shared/financial-year";
import { createTestShop, signInAs } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
type Session = Awaited<ReturnType<typeof signInAs>>["session"];
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
const daysAgo = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
let n = 0;

async function setup() {
  n += 1;
  const shop = await createTestShop(db, `Control ${n}`);
  const session = (await signInAs(shop.users.owner)).session;
  const { id: productId } = await createProduct(session, { name: `Tap ${n}`, sku: `CC-${n}`, baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "60" });
  await recordOpeningStock(session, { idempotencyKey: key(), movementDate: today, lines: [{ productId, unit: "pc", quantity: "1000" }] });
  return { shop, session, productId };
}
async function sell(session: Session, input: BillInput) {
  const preview = await previewBill(session, input);
  return createInvoice(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}
const customer = (session: Session, extra: Record<string, unknown> = {}) =>
  createCustomer(session, { name: `Buyer ${++n}`, phone: String(9400000000 + n), type: "retail", creditLimit: "1000000", ...extra }).then((result) => result.id);

describe("daily control center", () => {
  it("splits money actually received into cash, UPI and other, and never counts a credit sale as received", async () => {
    const { session, productId } = await setup();
    const buyer = await customer(session);
    await sell(session, { lines: [{ productId, unit: "pc", quantity: "5" }], payments: { cash: "500" } });
    await sell(session, { lines: [{ productId, unit: "pc", quantity: "3" }], payments: { upi: "300" } });
    await sell(session, { lines: [{ productId, unit: "pc", quantity: "2" }], payments: { card: "200" } });
    await sell(session, { customerId: buyer, lines: [{ productId, unit: "pc", quantity: "10" }] }); // ₹1,000 on udhaar
    await recordCustomerReceipt(session, { idempotencyKey: key(), customerId: buyer, amount: "400", method: "cash" });

    const dash = await getDashboard(session);
    expect(dash.sales.billedPaise).toBe(200000);
    expect(dash.money.collectedPaise).toBe(140000); // ₹2,000 billed, only ₹1,400 actually received
    expect(dash.money.split).toEqual({ cashPaise: 90000, upiPaise: 30000, otherPaise: 20000 });
    expect(dash.money.split.cashPaise + dash.money.split.upiPaise + dash.money.split.otherPaise).toBe(dash.money.collectedPaise);
    expect(dash.receivables?.receivablePaise).toBe(60000);
  });

  it("lists overdue customers first with their dues, and drops them once their payment is recorded", async () => {
    const { session, productId } = await setup();
    const late = await customer(session, { openingOwed: "500", oldestBillDate: daysAgo(45) });
    const big = await customer(session);
    await sell(session, { customerId: big, lines: [{ productId, unit: "pc", quantity: "80" }] }); // ₹8,000, not overdue

    let dash = await getDashboard(session);
    expect(dash.receivables).toMatchObject({ customersOwing: 2, overdueCustomers: 1, receivablePaise: 850000 });
    expect(dash.receivables?.top.map((row) => row.id)).toEqual([late, big]); // overdue ₹500 before the bigger ₹8,000
    expect(dash.receivables?.top[0]).toMatchObject({ balancePaise: 50000, overduePaise: 50000, oldestDueDays: 45 });

    await recordCustomerReceipt(session, { idempotencyKey: key(), customerId: late, amount: "500", method: "upi" });
    dash = await getDashboard(session);
    expect(dash.receivables?.top.map((row) => row.id)).toEqual([big]);
    expect(dash.receivables).toMatchObject({ customersOwing: 1, overdueCustomers: 0, receivablePaise: 800000 });
    expect(await partyBalance(session.shopId, "customer", late)).toBe(0);
    expect(dash.money.split.upiPaise).toBe(50000);
  });

  it("keeps each shop's collections and money to itself", async () => {
    const a = await setup();
    const b = await setup();
    const buyer = await customer(a.session, { openingOwed: "900", oldestBillDate: daysAgo(40) });
    await sell(a.session, { lines: [{ productId: a.productId, unit: "pc", quantity: "1" }], payments: { cash: "100" } });
    expect((await getDashboard(a.session)).receivables?.top.map((row) => row.id)).toEqual([buyer]);
    const theirs = await getDashboard(b.session);
    expect(theirs.receivables).toMatchObject({ customersOwing: 0, overdueCustomers: 0, top: [] });
    expect(theirs.money.split).toEqual({ cashPaise: 0, upiPaise: 0, otherPaise: 0 });
  });

  it("gives a new shop real zeros and offers only the actions each role may take", async () => {
    n += 1;
    const shop = await createTestShop(db, `Control empty ${n}`);
    const owner = (await signInAs(shop.users.owner)).session;
    const dash = await getDashboard(owner);
    expect(dash.receivables).toMatchObject({ customersOwing: 0, receivablePaise: 0, top: [] });
    expect(dash.money).toMatchObject({ collectedPaise: 0, split: { cashPaise: 0, upiPaise: 0, otherPaise: 0 } });
    expect(dash.actions).toEqual({ sale: true, collect: true, expense: true, purchase: true });
    const manager = await getDashboard((await signInAs(shop.users.manager)).session);
    for (const [action, allowed] of Object.entries(manager.actions)) expect(typeof allowed, action).toBe("boolean");
  });

  it("caps the list and breaks ties by name", () => {
    const row = (id: string, balancePaise: number, overduePaise = 0) => ({ id, name: id, phone: null, balancePaise, overduePaise, oldestDueDays: null, tone: "green" });
    const result = pendingCollections([row("b", 100), row("a", 100), row("c", 50, 50), row("d", 0), row("e", -20)], {}, 2);
    expect(result.top.map((r) => r.id)).toEqual(["c", "a"]);
    expect(result).toMatchObject({ customersOwing: 3, overdueCustomers: 1 });
  });
});
