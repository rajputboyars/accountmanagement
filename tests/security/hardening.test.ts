import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { closeDay, recordExpense, voidExpense } from "@/modules/cashbook";
import { createProduct } from "@/modules/catalog";
import { recordAdjustment, recordOpeningStock } from "@/modules/inventory";
import { createCustomer } from "@/modules/parties";
import { recordCustomerReceipt, reverseCustomerReceipt } from "@/modules/payments";
import { createSupplier, paySupplier, receiveGoods } from "@/modules/purchasing";
import { getDashboard } from "@/modules/reporting";
import { cancelInvoice, createInvoice, createReturn, getInvoice, getReturnableInvoice, previewBill, previewReturn, type BillInput } from "@/modules/sales";
import { updateGstSettings } from "@/modules/settings";
import { ForbiddenError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { createTestShop, signInAs } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
let n = 0;

async function setup() {
  n += 1;
  const shop = await createTestShop(db, `Hardening ${n}`);
  const owner = (await signInAs(shop.users.owner)).session;
  const { id: productId } = await createProduct(owner, { name: `Valve ${n}`, sku: `HV-${n}`, baseUnit: "pc", hsn: "8481", gstRateBp: "1800", retailPaise: "100", wholesalePaise: "90", costPaise: "60" });
  await recordOpeningStock(owner, { idempotencyKey: key(), movementDate: today, lines: [{ productId, unit: "pc", quantity: "100" }] });
  const { id: customerId } = await createCustomer(owner, { name: `Buyer ${n}`, phone: String(9600000000 + n), type: "retail", creditLimit: "100000", openingOwed: "500" });
  const { id: supplierId } = await createSupplier(owner, { name: `Vendor ${n}`, paymentTermsDays: "30" });
  return { shop, owner, productId, customerId, supplierId };
}

type Session = Awaited<ReturnType<typeof setup>>["owner"];

async function sell(session: Session, input: Partial<BillInput>, idempotencyKey = key()) {
  const preview = await previewBill(session, input as BillInput);
  return createInvoice(session, { ...input, idempotencyKey, expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}

/** Caches must equal their journals: balance = SUM(ledger), stock = SUM(movements). */
async function cachesMatchJournals(shopId: string) {
  const parties = await db.owner.execute<{ n: number }>(sql`
    select count(*)::int as n from party_balances pb
    left join (select party_type, party_id, sum(debit_paise - credit_paise) as total from ledger_entries where shop_id = ${shopId} group by party_type, party_id) le
      on le.party_type = pb.party_type and le.party_id = pb.party_id
    where pb.shop_id = ${shopId} and pb.balance_paise <> coalesce(le.total, 0)`);
  const missing = await db.owner.execute<{ n: number }>(sql`
    select count(*)::int as n from (select distinct party_type, party_id from ledger_entries where shop_id = ${shopId}) le
    where not exists (select 1 from party_balances pb where pb.party_type = le.party_type and pb.party_id = le.party_id)`);
  const stock = await db.owner.execute<{ n: number }>(sql`
    select count(*)::int as n from stock_levels sl
    left join (select product_id, sum(qty_base) as total from stock_movements where shop_id = ${shopId} group by product_id) sm on sm.product_id = sl.product_id
    where sl.shop_id = ${shopId} and sl.qty_base <> coalesce(sm.total, 0)`);
  return { parties: parties.rows[0]!.n, missing: missing.rows[0]!.n, stock: stock.rows[0]!.n };
}

describe("hardening: shop isolation on money and stock writes", () => {
  it("refuses every write that names another shop's records and leaves that shop untouched", async () => {
    const a = await setup();
    const b = await setup();
    const bill = await sell(a.owner, { customerId: a.customerId, lines: [{ productId: a.productId, unit: "pc", quantity: "2" }] } as Partial<BillInput>);
    const receipt = await recordCustomerReceipt(a.owner, { idempotencyKey: key(), customerId: a.customerId, amount: "100", method: "cash" });
    const expense = await recordExpense(a.owner, { idempotencyKey: key(), businessDate: today, category: "tea", amount: "50", method: "cash" });
    const before = await cachesMatchJournals(a.shop.shopId);
    const [lineId] = (await getReturnableInvoice(a.owner, bill.id)).lines.map((line) => line.id);

    const attempts = [
      getInvoice(b.owner, bill.id),
      cancelInvoice(b.owner, bill.id, { reason: "Mistake" }),
      createReturn(b.owner, { invoiceId: bill.id, lines: [{ invoiceLineId: lineId!, baseQty: "1", restock: true }], reason: "x x", settlement: "cash", idempotencyKey: key(), expectedTotalPaise: 11800 }),
      reverseCustomerReceipt(b.owner, receipt.id, { reason: "Mistake" }),
      voidExpense(b.owner, expense.id, { reason: "Mistake" }),
      recordCustomerReceipt(b.owner, { idempotencyKey: key(), customerId: a.customerId, amount: "100", method: "cash" }),
      paySupplier(b.owner, { idempotencyKey: key(), supplierId: a.supplierId, amount: "100", method: "cash" }),
      recordAdjustment(b.owner, { idempotencyKey: key(), productId: a.productId, kind: "damage", unit: "pc", quantity: "1", reason: "Broken" }),
      receiveGoods(b.owner, { idempotencyKey: key(), supplierId: a.supplierId, lines: [{ productId: a.productId, unit: "pc", quantity: "5", cost: "60", gstRateBp: "1800" }] }),
      sell(b.owner, { customerId: a.customerId, lines: [{ productId: b.productId, unit: "pc", quantity: "1" }] } as Partial<BillInput>),
      sell(b.owner, { lines: [{ productId: a.productId, unit: "pc", quantity: "1" }] } as Partial<BillInput>),
    ];
    const results = await Promise.allSettled(attempts);
    results.forEach((result, index) => expect(result.status, `attempt ${index}`).toBe("rejected"));
    expect(await cachesMatchJournals(a.shop.shopId)).toEqual(before);
    expect((await getInvoice(a.owner, bill.id)).status).toBe("issued");
  });

  it("keeps owner-only actions away from a cashier, whatever the screen shows", async () => {
    const { shop, productId, supplierId } = await setup();
    const owner = (await signInAs(shop.users.owner)).session;
    const cashier = (await signInAs(shop.users.cashier)).session;
    const bill = await sell(owner, { lines: [{ productId, unit: "pc", quantity: "1" }], payments: { cash: "118" } } as unknown as Partial<BillInput>);
    await expect(cancelInvoice(cashier, bill.id, { reason: "Mistake" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(closeDay(cashier, { businessDate: today, counted: "0" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(paySupplier(cashier, { idempotencyKey: key(), supplierId, amount: "1", method: "cash" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateGstSettings(cashier, { registration: "unregistered", gstin: "", gstRatesBp: [0] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getDashboard(cashier)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("hardening: duplicate submissions and failed transactions", () => {
  it("replays a double-submitted bill once and refuses the same key with a different bill", async () => {
    const { owner, productId, customerId } = await setup();
    const sameKey = key();
    const input = { customerId, lines: [{ productId, unit: "pc", quantity: "1" }] } as Partial<BillInput>;
    const [first, second] = await Promise.all([sell(owner, input, sameKey), sell(owner, input, sameKey)]);
    expect(first.id).toBe(second.id);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    await expect(sell(owner, { ...input, lines: [{ productId, unit: "pc", quantity: "2" }] } as Partial<BillInput>, sameKey)).rejects.toMatchObject({ status: 409 });
    const count = await db.owner.execute<{ n: number }>(sql`select count(*)::int as n from invoices where shop_id = ${owner.shopId}`);
    expect(count.rows[0]!.n).toBe(1);
  });

  it("a bill that fails mid-way saves nothing and uses no number", async () => {
    const { owner, productId, customerId } = await setup();
    await expect(sell(owner, { customerId, lines: [{ productId, unit: "pc", quantity: "1000" }] } as Partial<BillInput>)).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    const bill = await sell(owner, { customerId, lines: [{ productId, unit: "pc", quantity: "1" }] } as Partial<BillInput>);
    expect(bill.number).toMatch(/\/00001$/);
  });
});

describe("hardening: ledger and stock stay consistent across modules", () => {
  it("after bills, part payments, receipts, returns, a cancellation, purchases, a supplier payment, an adjustment and expenses, every cache equals its journal", async () => {
    const { owner, productId, customerId, supplierId } = await setup();
    const credit = await sell(owner, { customerId, lines: [{ productId, unit: "pc", quantity: "10" }], payments: { upi: "500" } } as unknown as Partial<BillInput>);
    const toCancel = await sell(owner, { customerId, lines: [{ productId, unit: "pc", quantity: "3" }], payments: { cash: "100" } } as unknown as Partial<BillInput>);
    await cancelInvoice(owner, toCancel.id, { reason: "Wrong customer" });
    const receipt = await recordCustomerReceipt(owner, { idempotencyKey: key(), customerId, amount: "300", method: "upi", reference: `UTR-${n}` });
    await reverseCustomerReceipt(owner, receipt.id, { reason: "Bounced" });
    await recordCustomerReceipt(owner, { idempotencyKey: key(), customerId, amount: "200", method: "cash" });
    const [lineId] = (await getReturnableInvoice(owner, credit.id)).lines.map((line) => line.id);
    const ret = { invoiceId: credit.id, lines: [{ invoiceLineId: lineId!, baseQty: "2", restock: true }], reason: "Extra", settlement: "ledger" as const };
    await createReturn(owner, { ...ret, idempotencyKey: key(), expectedTotalPaise: (await previewReturn(owner, ret)).totalPaise });
    await receiveGoods(owner, { idempotencyKey: key(), supplierId, lines: [{ productId, unit: "pc", quantity: "20", cost: "60", gstRateBp: "1800" }] });
    await paySupplier(owner, { idempotencyKey: key(), supplierId, amount: "500", method: "cash" });
    await recordAdjustment(owner, { idempotencyKey: key(), productId, kind: "damage", unit: "pc", quantity: "1", reason: "Cracked" });
    await recordExpense(owner, { idempotencyKey: key(), businessDate: today, category: "transport", amount: "80", method: "cash" });
    expect(await cachesMatchJournals(owner.shopId)).toEqual({ parties: 0, missing: 0, stock: 0 });
    // Stock: 100 opening − 10 sold (cancelled bill restored) + 2 returned + 20 received − 1 damaged.
    const stock = await db.owner.execute<{ qty: string }>(sql`select qty_base::text as qty from stock_levels where product_id = ${productId}`);
    expect(Number(stock.rows[0]!.qty)).toBe(111);
    // A purchase at a notified rate the shop doesn't sell at (3%) can still be recorded.
    await expect(receiveGoods(owner, { idempotencyKey: key(), supplierId, lines: [{ productId, unit: "pc", quantity: "1", cost: "60", gstRateBp: "300" }] })).resolves.toMatchObject({ number: expect.stringMatching(/^GRN\//) });
  });
});
