import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auditLog } from "@/modules/audit/schema";
import { addProductUnit, createProduct } from "@/modules/catalog";
import { products } from "@/modules/catalog/schema";
import { getProductStock, recordOpeningStock } from "@/modules/inventory";
import { stockMovements } from "@/modules/inventory/schema";
import { appendLedgerEntry, partyBalance } from "@/modules/ledger";
import { ledgerEntries, partyBalances } from "@/modules/ledger/schema";
import { customers } from "@/modules/parties/schema";
import { payments } from "@/modules/payments/schema";
import { addCustomerRule, addSlab } from "@/modules/pricing";
import { cancelInvoice, createInvoice, getInvoice, previewBill, type BillInput } from "@/modules/sales";
import { invoices } from "@/modules/sales/schema";
import { withTransaction } from "@/server/db";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
let shopA: TestShop;
let shopB: TestShop;
type Session = Awaited<ReturnType<typeof signInAs>>["session"];
const owner = async (shop = shopA) => (await signInAs(shop.users.owner)).session;
const key = () => `k_${randomUUID().replace(/-/g, "")}`;

let counter = 0;
async function product(shop: TestShop, spec: { retail: string; wholesale: string; cost?: string; gst?: string; baseUnit?: string; stock: string; box?: string }) {
  counter += 1;
  const session = await owner(shop);
  const { id } = await createProduct(session, {
    name: `Item ${counter}`,
    sku: `IT-${counter}`,
    baseUnit: spec.baseUnit ?? "pc",
    hsn: "3917",
    gstRateBp: spec.gst ?? "1800",
    retailPaise: spec.retail,
    wholesalePaise: spec.wholesale,
    costPaise: spec.cost ?? "",
  });
  if (spec.box) await addProductUnit(session, id, { unit: "box", factor: spec.box });
  await recordOpeningStock(session, { idempotencyKey: key(), movementDate: indiaDate(), lines: [{ productId: id, unit: spec.baseUnit ?? "pc", quantity: spec.stock }] });
  return id;
}

async function customer(shop: TestShop, type: "retail" | "wholesale", creditLimitPaise = 0, openingPaise = 0) {
  const id = randomUUID();
  await db.owner.insert(customers).values({ id, shopId: shop.shopId, name: `Customer ${++counter}`, type, creditLimitPaise });
  if (openingPaise) {
    await withTransaction((tx) =>
      appendLedgerEntry(tx, { shopId: shop.shopId, partyType: "customer", partyId: id, entryDate: "2026-09-10", kind: "opening", sourceType: "opening_balance", sourceId: randomUUID(), debitPaise: openingPaise }),
    );
  }
  return id;
}

/** Preview, then save with exactly what the preview showed (what the counter screen does). */
async function sell(session: Session, input: BillInput, options: { idempotencyKey?: string } = {}) {
  const preview = await previewBill(session, input);
  return createInvoice(session, { ...input, idempotencyKey: options.idempotencyKey ?? key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}

const counts = async (shopId: string) => {
  const [row] = await db.owner.execute<{ i: number; m: number; p: number; l: number }>(sql`
    select (select count(*)::int from invoices where shop_id = ${shopId}) as i,
           (select count(*)::int from stock_movements where shop_id = ${shopId} and kind = 'sale') as m,
           (select count(*)::int from payments where shop_id = ${shopId}) as p,
           (select count(*)::int from ledger_entries where shop_id = ${shopId} and kind <> 'opening') as l`).then((result) => result.rows);
  return row!;
};

async function cacheMatchesLedger(customerId: string) {
  const [cache] = await db.owner.select().from(partyBalances).where(eq(partyBalances.partyId, customerId));
  expect(cache?.balancePaise).toBe(await partyBalance(shopA.shopId, "customer", customerId));
}

// Spec Example A products (wholesale prices, slabs) and a Gupta-like customer with 1% off everything.
let pipe: string, elbow: string, valve: string, tape: string, basin: string, gupta: string;

beforeAll(async () => {
  shopA = await createTestShop(db, "Shop A");
  shopB = await createTestShop(db, "Shop B");
  const session = await owner();
  pipe = await product(shopA, { retail: "540", wholesale: "470", cost: "402", stock: "500" });
  await addSlab(session, pipe, { minQty: "50", price: "455" });
  await addSlab(session, pipe, { minQty: "100", price: "440" });
  elbow = await product(shopA, { retail: "38", wholesale: "31", cost: "22", stock: "2000", box: "50" });
  await addSlab(session, elbow, { minQty: "100", price: "28" });
  valve = await product(shopA, { retail: "320", wholesale: "275", cost: "228", stock: "100" });
  tape = await product(shopA, { retail: "120", wholesale: "95", baseUnit: "box", stock: "50" });
  basin = await product(shopA, { retail: "2400", wholesale: "2050", stock: "20" });
  gupta = await customer(shopA, "wholesale", 10000000, 6200000);
  await addCustomerRule(session, { kind: "pct", customerId: gupta, productId: "", percent: "1" });
});

const exampleA = (overrides: Partial<BillInput> = {}): BillInput => ({
  customerId: gupta,
  lines: [
    { productId: pipe, unit: "pc", quantity: "60" },
    { productId: elbow, unit: "pc", quantity: "120" },
    { productId: valve, unit: "pc", quantity: "10" },
    { productId: tape, unit: "box", quantity: "2" },
  ],
  ...overrides,
});

describe("bill totals (spec Examples A and B)", () => {
  it("Example A: rates, GST and round-off match the spec; credit beyond the limit is blocked", async () => {
    const preview = await previewBill(await owner(), exampleA());
    expect(preview.lines.map((line) => line.ratePaise)).toEqual([45045, 2772, 27225, 9405]);
    expect(preview.lines.map((line) => line.rateReason)).toEqual(["Slab 50+ −1%", "Slab 100+ −1%", "Wholesale −1%", "Wholesale −1%"]);
    expect(preview.totals).toMatchObject({ subtotalPaise: 3326400, cgstPaise: 299376, sgstPaise: 299376, totalPaise: 3925200, roundOffPaise: 48 });
    expect(preview.problems.map((problem) => problem.code)).toEqual(["CREDIT_LIMIT"]);
    await expect(sell(await owner(), exampleA())).rejects.toMatchObject({ code: "CREDIT_LIMIT" });
  });

  it("Example A part-paid: ₹20,000 UPI now, the rest goes to dues; ledger and stock agree", async () => {
    const before = await partyBalance(shopA.shopId, "customer", gupta);
    const result = await sell(await owner(), exampleA({ payments: { upi: "20000" } }));
    expect(result).toMatchObject({ totalPaise: 3925200, replayed: false });
    expect(result.number).toMatch(/^INV\/\d{2}-\d{2}\/\d{5}$/);
    expect(await partyBalance(shopA.shopId, "customer", gupta)).toBe(before + 3925200 - 2000000);
    await cacheMatchesLedger(gupta);
    const entries = await db.owner.select().from(ledgerEntries).where(eq(ledgerEntries.sourceId, result.id));
    expect(entries).toEqual([expect.objectContaining({ kind: "invoice", debitPaise: 3925200 })]);
    const paid = await db.owner.select().from(payments).where(eq(payments.invoiceId, result.id));
    expect(paid).toEqual([expect.objectContaining({ method: "upi", amountPaise: 2000000, direction: "in", partyType: "customer" })]);
    const moves = await db.owner.select().from(stockMovements).where(and(eq(stockMovements.sourceId, result.id), eq(stockMovements.kind, "sale")));
    expect(moves.map((move) => move.qtyBase).sort()).toEqual(["-10.000", "-120.000", "-2.000", "-60.000"]);
    const invoice = await getInvoice(await owner(), result.id);
    expect(invoice.lines[0]).toMatchObject({ rateReason: "Slab 50+ −1%", ratePaise: 45045, qty: "60" });
    expect(invoice).not.toHaveProperty("lines.0.unitCostPaise", 40200);
    const [audit] = await db.owner.select().from(auditLog).where(and(eq(auditLog.entityId, result.id), eq(auditLog.action, "sales.invoice_issued")));
    expect(audit).toBeDefined();
  });

  it("Example B: walk-in, owner's 2% discount, split cash + UPI, change from ₹6,000", async () => {
    const session = await owner();
    const input: BillInput = { lines: [{ productId: basin, unit: "pc", quantity: "2" }], discountPercent: "2", payments: { cash: "3000", upi: "2551" }, cashReceived: "6000" };
    const preview = await previewBill(session, input);
    expect(preview.totals).toMatchObject({ taxablePaise: 470400, totalPaise: 555100, roundOffPaise: 28 });
    expect(preview.totals.cgstPaise + preview.totals.sgstPaise).toBe(84672);
    expect(preview.changePaise).toBe(300000);
    const result = await sell(session, input);
    const rows = await db.owner.select().from(payments).where(eq(payments.invoiceId, result.id));
    expect(rows.map((row) => [row.method, row.amountPaise]).sort()).toEqual([["cash", 300000], ["upi", 255100]]);
    expect(rows.every((row) => row.partyType === "none")).toBe(true);
    expect(await db.owner.select().from(ledgerEntries).where(eq(ledgerEntries.sourceId, result.id))).toHaveLength(0);
    const preview2 = await previewBill(session, { ...input, payments: { cash: "5551" } });
    expect(preview2.changePaise).toBe(44900);
  });

  it("3 boxes of 50 elbows use the 100+ slab: base 150 pc, box rate ₹1,400", async () => {
    const preview = await previewBill(await owner(), { customerId: await customer(shopA, "wholesale", 10000000), lines: [{ productId: elbow, unit: "box", quantity: "3" }] });
    expect(preview.lines[0]).toMatchObject({ baseQuantity: "150", ratePaise: 140000, amountPaise: 420000, rateReason: "Slab 100+" });
  });
});

describe("refusals", () => {
  it("blocks credit for walk-in, discounts above the role limit, overpayment and short cash", async () => {
    const { session: cashier } = await signInAs(shopA.users.cashier);
    const line = [{ productId: valve, unit: "pc", quantity: "1" }];
    const codes = async (input: BillInput) => (await previewBill(cashier, input)).problems.map((problem) => problem.code);
    expect(await codes({ lines: line })).toEqual(["CREDIT_NEEDS_CUSTOMER"]);
    expect(await codes({ lines: line, discountPercent: "5", payments: { cash: "400" } })).toContain("DISCOUNT_APPROVAL_REQUIRED");
    expect(await codes({ lines: line, discountPercent: "3", payments: { cash: "366" } })).toEqual([]); // ₹320 − 3% = ₹310.40, + 18% GST → ₹366.28 → ₹366
    expect(await codes({ lines: line, payments: { cash: "999" } })).toEqual(["OVERPAID"]);
    expect(await codes({ lines: line, payments: { cash: "378" }, cashReceived: "300" })).toEqual(["CASH_SHORT"]);
  });

  it("refuses selling more than the stock and writes nothing", async () => {
    const session = await owner();
    const before = await counts(shopA.shopId);
    const input: BillInput = { lines: [{ productId: basin, unit: "pc", quantity: "999" }], payments: { cash: "1" } };
    const preview = await previewBill(session, input);
    expect(preview.problems[0]).toMatchObject({ code: "INSUFFICIENT_STOCK", message: expect.stringMatching(/^Only \d+ pc of/) });
    await expect(createInvoice(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates })).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(await counts(shopA.shopId)).toEqual(before);
  });

  it("refuses a save when a price changed after the preview, and returns the new bill", async () => {
    const session = await owner();
    const id = await product(shopA, { retail: "100", wholesale: "90", stock: "10" });
    const input: BillInput = { lines: [{ productId: id, unit: "pc", quantity: "1" }], payments: { cash: "118" } };
    const preview = await previewBill(session, input);
    await db.owner.update(products).set({ retailPaise: 11000 }).where(eq(products.id, id));
    const before = await counts(shopA.shopId);
    const error = await createInvoice(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "PRICE_CHANGED", details: { bill: { totals: { totalPaise: 13000 } } } });
    expect(await counts(shopA.shopId)).toEqual(before);
  });

  it("rolls everything back if a write fails part-way (number already taken)", async () => {
    const session = await owner();
    const before = await counts(shopA.shopId);
    const [series] = await db.owner.execute<{ fy: string; next_value: number }>(sql`select fy, next_value from number_series where shop_id = ${shopA.shopId} and series = 'INV' order by fy desc limit 1`).then((result) => result.rows);
    const taken = `INV/${series!.fy}/${String(series!.next_value).padStart(5, "0")}`;
    const walkIn = await db.owner.select({ id: customers.id }).from(customers).where(and(eq(customers.shopId, shopA.shopId), eq(customers.type, "walkin")));
    // Occupy the next number directly, as if another system had used it.
    await db.owner.insert(invoices).values({ id: randomUUID(), shopId: shopA.shopId, fy: series!.fy, number: taken, businessDate: indiaDate(), customerId: walkIn[0]!.id, priceList: "retail", createdBy: shopA.users.owner.id, subtotalPaise: 100, taxablePaise: 100, cgstPaise: 0, sgstPaise: 0, roundOffPaise: 0, totalPaise: 100, costComplete: false });
    await expect(sell(session, { lines: [{ productId: valve, unit: "pc", quantity: "1" }], payments: { cash: "378" } })).rejects.toThrow();
    const after = await counts(shopA.shopId);
    expect(after).toEqual({ ...before, i: before.i + 1 }); // only the row inserted above
    const [seriesAfter] = await db.owner.execute<{ next_value: number }>(sql`select next_value from number_series where shop_id = ${shopA.shopId} and series = 'INV' and fy = ${series!.fy}`).then((result) => result.rows);
    expect(seriesAfter!.next_value).toBe(series!.next_value);
    await db.owner.execute(sql`update number_series set next_value = next_value + 1 where shop_id = ${shopA.shopId} and series = 'INV' and fy = ${series!.fy}`);
  });
});

describe("concurrency and duplicates", () => {
  it("returns the first invoice for a repeated submission", async () => {
    const session = await owner();
    const idempotencyKey = key();
    const input: BillInput = { lines: [{ productId: valve, unit: "pc", quantity: "1" }], payments: { cash: "378" } };
    const first = await sell(session, input, { idempotencyKey });
    const again = await sell(session, input, { idempotencyKey });
    expect(again).toMatchObject({ id: first.id, number: first.number, replayed: true });
    expect(await db.owner.select().from(invoices).where(eq(invoices.id, first.id))).toHaveLength(1);
  });

  it("lets only as many simultaneous bills through as there is stock, with gap-free numbers", async () => {
    const session = await owner();
    const id = await product(shopA, { retail: "100", wholesale: "90", gst: "0", stock: "5" });
    const input: BillInput = { lines: [{ productId: id, unit: "pc", quantity: "3" }], payments: { cash: "300" } };
    const preview = await previewBill(session, input);
    const attempt = () => createInvoice(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
    const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await getProductStock(session, id)).qty).toBe("2");
    const numbers = (await db.owner.select({ number: invoices.number }).from(invoices).where(eq(invoices.shopId, shopA.shopId))).map((row) => Number(row.number.slice(-5))).sort((a, b) => a - b);
    expect(numbers).toEqual(numbers.map((_, index) => numbers[0]! + index));
  });
});

describe("cancelling a bill", () => {
  it("reverses stock, refunds payments and nets the customer's dues to zero", async () => {
    const session = await owner();
    const buyer = await customer(shopA, "wholesale", 10000000);
    const sold = await sell(session, { customerId: buyer, lines: [{ productId: valve, unit: "pc", quantity: "2" }], payments: { cash: "100" } });
    const stockBefore = (await getProductStock(session, valve)).qty;
    expect(await partyBalance(shopA.shopId, "customer", buyer)).toBeGreaterThan(0);
    await expect(cancelInvoice(session, sold.id, { reason: "" })).rejects.toThrow();
    await cancelInvoice(session, sold.id, { reason: "Customer changed mind" });
    expect(Number((await getProductStock(session, valve)).qty)).toBe(Number(stockBefore) + 2);
    expect(await partyBalance(shopA.shopId, "customer", buyer)).toBe(0);
    const rows = await db.owner.select().from(payments).where(eq(payments.invoiceId, sold.id));
    expect(rows.map((row) => [row.direction, row.status]).sort()).toEqual([["in", "reversed"], ["out", "recorded"]]);
    const invoice = await getInvoice(session, sold.id);
    expect(invoice).toMatchObject({ status: "cancelled", cancelReason: "Customer changed mind", canCancel: false });
    await expect(cancelInvoice(session, sold.id, { reason: "Again" })).rejects.toMatchObject({ code: "ALREADY_CANCELLED" });
    await cacheMatchesLedger(buyer);
  });

  it("only the owner can cancel", async () => {
    const sold = await sell(await owner(), { lines: [{ productId: valve, unit: "pc", quantity: "1" }], payments: { cash: "378" } });
    for (const role of ["manager", "cashier"] as const) {
      const { session } = await signInAs(shopA.users[role]);
      await expect(cancelInvoice(session, sold.id, { reason: "Wrong item" })).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});

describe("dues, permissions and isolation", () => {
  it("uses an advance first: a customer who paid ahead can buy within a zero credit limit", async () => {
    const buyer = await customer(shopA, "wholesale", 0);
    await withTransaction((tx) =>
      appendLedgerEntry(tx, { shopId: shopA.shopId, partyType: "customer", partyId: buyer, entryDate: indiaDate(), kind: "payment", sourceType: "test_advance", sourceId: randomUUID(), creditPaise: 50000 }),
    );
    const { session: cashier } = await signInAs(shopA.users.cashier);
    // Valve wholesale ₹275 + 18% = ₹324.50 → ₹325 (half-up), within the ₹500 advance.
    const sold = await sell(cashier, { customerId: buyer, lines: [{ productId: valve, unit: "pc", quantity: "1" }] });
    expect(sold.totalPaise).toBe(32500);
    expect(await partyBalance(shopA.shopId, "customer", buyer)).toBe(-17500);
    await expect(sell(cashier, { customerId: buyer, lines: [{ productId: valve, unit: "pc", quantity: "1" }] })).rejects.toMatchObject({ code: "CREDIT_LIMIT" });
  });

  it("lets cashiers bill but not inventory staff", async () => {
    const { session: inventory } = await signInAs(shopA.users.inventory);
    await expect(previewBill(inventory, { lines: [{ productId: valve, unit: "pc", quantity: "1" }] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createInvoice(inventory, { lines: [{ productId: valve, unit: "pc", quantity: "1" }], idempotencyKey: key(), expectedTotalPaise: 0, expectedRates: [0] })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("never touches another shop's products, customers or bills", async () => {
    const theirProduct = await product(shopB, { retail: "100", wholesale: "90", stock: "10" });
    const theirCustomer = await customer(shopB, "wholesale", 1000000);
    const theirBill = await sell(await owner(shopB), { lines: [{ productId: theirProduct, unit: "pc", quantity: "1" }], payments: { cash: "118" } });
    const session = await owner();
    await expect(previewBill(session, { lines: [{ productId: theirProduct, unit: "pc", quantity: "1" }], payments: { cash: "118" } })).rejects.toBeInstanceOf(NotFoundError);
    await expect(previewBill(session, { customerId: theirCustomer, lines: [{ productId: valve, unit: "pc", quantity: "1" }] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(getInvoice(session, theirBill.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(cancelInvoice(session, theirBill.id, { reason: "Not mine" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await getProductStock(await owner(shopB), theirProduct)).qty).toBe("9");
  });

  it("keeps the ledger append-only", async () => {
    await expect(db.owner.execute(sql`update ledger_entries set debit_paise = 1 where party_id = ${gupta}`)).rejects.toThrow();
  });
});
