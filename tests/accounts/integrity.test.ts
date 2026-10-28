import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createProduct } from "@/modules/catalog";
import { getProductStock, recordOpeningStock } from "@/modules/inventory";
import { stockMovements } from "@/modules/inventory/schema";
import { partyBalance } from "@/modules/ledger";
import { ledgerEntries, partyBalances } from "@/modules/ledger/schema";
import { createCustomer } from "@/modules/parties";
import { recordCustomerReceipt } from "@/modules/payments";
import { payments } from "@/modules/payments/schema";
import { cancelGoodsReceipt, createSupplier, receiveGoods } from "@/modules/purchasing";
import { cancelInvoice, createInvoice, previewBill, type BillInput } from "@/modules/sales";
import { financialYearLabel, indiaDate } from "@/shared/financial-year";
import { addDays } from "@/shared/report-range";
import { createTestShop, signInAs } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

/**
 * Integrity under failure and contention: a write that fails part-way leaves nothing behind, races
 * on the same balance or document resolve to one outcome, and refused reversals change nothing.
 */
const db = setupTestDatabase();
type Session = Awaited<ReturnType<typeof signInAs>>["session"];
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
let n = 0;

async function setup() {
  n += 1;
  const shop = await createTestShop(db, `Integrity ${n}`);
  const session = (await signInAs(shop.users.owner)).session;
  const { id: productId } = await createProduct(session, { name: `Tap ${n}`, sku: `IN-${n}`, baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "60" });
  await recordOpeningStock(session, { idempotencyKey: key(), movementDate: today, lines: [{ productId, unit: "pc", quantity: "100" }] });
  return { shop, session, productId };
}
async function sell(session: Session, input: BillInput, idempotencyKey = key()) {
  const preview = await previewBill(session, input);
  return createInvoice(session, { ...input, idempotencyKey, expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}
const customer = (session: Session, extra: Record<string, unknown> = {}) =>
  createCustomer(session, { name: `Party ${++n}`, phone: String(9830000000 + n), type: "retail", creditLimit: "100000", ...extra }).then((result) => result.id);

/** Everything a money or stock write touches, for before/after comparisons. */
async function snapshot(shopId: string) {
  const count = async (table: typeof payments | typeof ledgerEntries | typeof stockMovements) => (await db.owner.select({ n: sql<number>`count(*)::int` }).from(table).where(eq(table.shopId, shopId)))[0]!.n;
  const balances = await db.owner.select({ party: partyBalances.partyId, paise: partyBalances.balancePaise }).from(partyBalances).where(eq(partyBalances.shopId, shopId));
  const series = await db.owner.execute<{ series: string; next_value: number }>(sql`select series, next_value from number_series where shop_id = ${shopId} order by series`);
  return { payments: await count(payments), ledger: await count(ledgerEntries), movements: await count(stockMovements), balances: balances.sort((a, b) => a.party.localeCompare(b.party)), series: series.rows };
}

describe("integrity under failure and contention", () => {
  it("rolls a receipt back completely when it fails part-way, and the same submission then saves once", async () => {
    const { shop, session } = await setup();
    const buyer = await customer(session, { openingOwed: "500" });
    const [series] = (await db.owner.execute<{ fy: string; next_value: number }>(sql`select fy, next_value from number_series where shop_id = ${shop.shopId} and series = 'RCPT' order by fy desc limit 1`)).rows;
    const fy = series?.fy ?? financialYearLabel();
    const next = series?.next_value ?? 1;
    // Occupy the next receipt number directly, as if another system had used it.
    const blockerId = randomUUID();
    await db.owner.insert(payments).values({ id: blockerId, shopId: shop.shopId, fy, receiptNumber: `RCPT/${fy}/${String(next).padStart(5, "0")}`, direction: "in", partyType: "none", partyId: null, method: "cash", amountPaise: 1, businessDate: today, recordedBy: shop.users.owner.id });
    const before = await snapshot(shop.shopId);
    const idempotencyKey = key();
    await expect(recordCustomerReceipt(session, { idempotencyKey, customerId: buyer, amount: "200", method: "cash" })).rejects.toThrow();
    expect(await snapshot(shop.shopId)).toEqual(before); // no payment, ledger line, balance change or number used
    expect(await partyBalance(shop.shopId, "customer", buyer)).toBe(50000);

    await db.owner.delete(payments).where(eq(payments.id, blockerId));
    const saved = await recordCustomerReceipt(session, { idempotencyKey, customerId: buyer, amount: "200", method: "cash" });
    expect(saved.replayed).toBe(false);
    expect(await recordCustomerReceipt(session, { idempotencyKey, customerId: buyer, amount: "200", method: "cash" })).toMatchObject({ id: saved.id, replayed: true });
    expect(await partyBalance(shop.shopId, "customer", buyer)).toBe(30000);
  });

  it("lets only as much credit through as the limit allows when two credit bills race", async () => {
    const { session, productId } = await setup();
    const buyer = await customer(session, { creditLimit: "1000" });
    const bill: BillInput = { customerId: buyer, lines: [{ productId, unit: "pc", quantity: "6" }] }; // ₹600 each, all on credit
    const results = await Promise.allSettled([sell(session, bill), sell(session, bill)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "CREDIT_LIMIT" } });
    expect(await partyBalance(session.shopId, "customer", buyer)).toBe(60000);
    expect((await getProductStock(session, productId)).qty).toBe("94");
  });

  it("cancels a part-paid bill once when two cancellations race, refunding and restocking once", async () => {
    const { shop, session, productId } = await setup();
    const buyer = await customer(session);
    const bill = await sell(session, { customerId: buyer, lines: [{ productId, unit: "pc", quantity: "10" }], payments: { cash: "400" } });
    const results = await Promise.allSettled([cancelInvoice(session, bill.id, { reason: "Wrong items" }), cancelInvoice(session, bill.id, { reason: "Wrong items" })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "ALREADY_CANCELLED" } });
    expect((await getProductStock(session, productId)).qty).toBe("100");
    expect(await partyBalance(shop.shopId, "customer", buyer)).toBe(0);
    const refunds = await db.owner.select().from(payments).where(and(eq(payments.invoiceId, bill.id), eq(payments.direction, "out")));
    expect(refunds.map((row) => row.amountPaise)).toEqual([40000]);
    const cancelMoves = await db.owner.select().from(stockMovements).where(and(eq(stockMovements.sourceId, bill.id), eq(stockMovements.kind, "sale_cancel")));
    expect(cancelMoves).toHaveLength(1);
  });

  it("changes nothing when a cancellation is refused", async () => {
    const { shop, session, productId } = await setup();
    // A receipt whose goods were already sold can't be cancelled.
    const { id: supplier } = await createSupplier(session, { name: `Supplier ${n}`, phone: "9000001101", paymentTermsDays: "30" });
    const { id: fresh } = await createProduct(session, { name: `Fresh ${n}`, sku: `FR-${n}`, baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "60" });
    const receipt = await receiveGoods(session, { idempotencyKey: key(), supplierId: supplier, lines: [{ productId: fresh, unit: "pc", quantity: "5", cost: "60", gstRateBp: "0" }] });
    await sell(session, { lines: [{ productId: fresh, unit: "pc", quantity: "3" }], payments: { cash: "300" } });
    let before = await snapshot(shop.shopId);
    await expect(cancelGoodsReceipt(session, receipt.id, { reason: "Wrong supplier" })).rejects.toMatchObject({ code: "STOCK_ALREADY_USED" });
    expect(await snapshot(shop.shopId)).toEqual(before);

    // A bill from an earlier day can't be cancelled (a credit note is the way).
    const old = await sell(session, { lines: [{ productId, unit: "pc", quantity: "1" }], payments: { cash: "100" } });
    await db.owner.execute(sql`update invoices set business_date = ${addDays(today, -1)} where id = ${old.id}`);
    before = await snapshot(shop.shopId);
    await expect(cancelInvoice(session, old.id, { reason: "Too late" })).rejects.toMatchObject({ code: "NOT_SAME_DAY" });
    expect(await snapshot(shop.shopId)).toEqual(before);
  });
});
