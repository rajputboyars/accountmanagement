import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auditLog } from "@/modules/audit/schema";
import { addProductUnit, createProduct, getProduct } from "@/modules/catalog";
import { productCostHistory } from "@/modules/catalog/schema";
import { getProductStock, recordAdjustment, recordOpeningStock } from "@/modules/inventory";
import { appendLedgerEntry, partyBalance } from "@/modules/ledger";
import { partyBalances } from "@/modules/ledger/schema";
import {
  cancelGoodsReceipt,
  cancelPurchaseOrder,
  closePurchaseOrder,
  createPurchaseOrder,
  createSupplier,
  getPurchaseOrder,
  getSupplier,
  listSuppliers,
  paySupplier,
  receiveGoods,
  reverseSupplierPayment,
} from "@/modules/purchasing";
import { goodsReceipts } from "@/modules/purchasing/schema";
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
async function product(shop: TestShop, spec: { cost?: string; gst?: string; baseUnit?: string; stock?: string; box?: string }) {
  counter += 1;
  const session = await owner(shop);
  const { id } = await createProduct(session, { name: `Item ${counter}`, sku: `IT-${counter}`, baseUnit: spec.baseUnit ?? "pc", hsn: "3917", gstRateBp: spec.gst ?? "1800", retailPaise: "500", wholesalePaise: "450", costPaise: spec.cost ?? "" });
  if (spec.box) await addProductUnit(session, id, { unit: "box", factor: spec.box });
  if (spec.stock) await recordOpeningStock(session, { idempotencyKey: key(), movementDate: indiaDate(), lines: [{ productId: id, unit: spec.baseUnit ?? "pc", quantity: spec.stock }] });
  return id;
}

async function supplier(shop: TestShop, openingOwedPaise = 0) {
  counter += 1;
  const { id } = await createSupplier(await owner(shop), { name: `Supplier ${counter}`, phone: "9000002002", paymentTermsDays: "30" });
  if (openingOwedPaise) {
    await withTransaction((tx) => appendLedgerEntry(tx, { shopId: shop.shopId, partyType: "supplier", partyId: id, entryDate: "2026-10-01", kind: "opening", sourceType: "opening_balance", sourceId: randomUUID(), creditPaise: openingOwedPaise }));
  }
  return id;
}

const owed = async (supplierId: string, shop = shopA) => 0 - (await partyBalance(shop.shopId, "supplier", supplierId));
const stockOf = async (productId: string, session?: Session) => (await getProductStock(session ?? (await owner()), productId)).qty;

async function order(session: Session, supplierId: string, lines: { productId: string; unit: string; quantity: string; cost: string }[]) {
  return createPurchaseOrder(session, { idempotencyKey: key(), supplierId, lines });
}

async function receiveOrder(session: Session, orderId: string, quantities: Record<string, string>, extra: Record<string, unknown> = {}) {
  const po = await getPurchaseOrder(session, orderId);
  const lines = po.lines.filter((line) => quantities[line.productId]).map((line) => ({ purchaseOrderLineId: line.id, quantity: quantities[line.productId]!, cost: String(line.costPaisePerUnit / 100), gstRateBp: "0" }));
  return receiveGoods(session, { idempotencyKey: key(), purchaseOrderId: orderId, lines, ...extra });
}

let elbow: string, tape: string, supreme: string;

beforeAll(async () => {
  shopA = await createTestShop(db, "Shop A");
  shopB = await createTestShop(db, "Shop B");
  elbow = await product(shopA, { cost: "22", stock: "1914" });
  tape = await product(shopA, { baseUnit: "box", cost: "70", stock: "10" });
  supreme = await supplier(shopA, 2280000);
});

describe("spec S1, S2 and S5", () => {
  it("S1: receiving PB-7790 in full adds 500 elbows and 20 boxes, and Supreme's dues go ₹22,800 → ₹35,200", async () => {
    const session = await owner();
    expect(await owed(supreme)).toBe(2280000);
    const po = await order(session, supreme, [
      { productId: elbow, unit: "pc", quantity: "500", cost: "22" },
      { productId: tape, unit: "box", quantity: "20", cost: "70" },
    ]);
    expect(po.number).toMatch(/^PO\/\d{2}-\d{2}\/00001$/);
    const receipt = await receiveOrder(session, po.id, { [elbow]: "500", [tape]: "20" }, { supplierBillNo: "sp-1001" });
    expect(receipt).toMatchObject({ totalPaise: 1240000 });
    expect(receipt.number).toMatch(/^GRN\/\d{2}-\d{2}\/00001$/);
    expect(await stockOf(elbow)).toBe("2414");
    expect(await stockOf(tape)).toBe("30");
    expect(await owed(supreme)).toBe(3520000);
    expect((await getPurchaseOrder(session, po.id)).status).toBe("received");
    const [cache] = await db.owner.select().from(partyBalances).where(eq(partyBalances.partyId, supreme));
    expect(-cache!.balancePaise).toBe(3520000);
    const [audit] = await db.owner.select().from(auditLog).where(and(eq(auditLog.entityId, receipt.id), eq(auditLog.action, "purchasing.goods_received")));
    expect(audit).toBeDefined();
    // Owner pays ₹10,000 by bank → ₹25,200 (spec §5).
    expect((await paySupplier(session, { idempotencyKey: key(), supplierId: supreme, amount: "10000", method: "bank", reference: "NEFT-1" })).owedAfterPaise).toBe(2520000);
  });

  it("S2: a short delivery is 'received · short' at ₹11,300, can't be over-received, and the owner can close it", async () => {
    const session = await owner();
    const po = await order(session, supreme, [
      { productId: elbow, unit: "pc", quantity: "500", cost: "22" },
      { productId: tape, unit: "box", quantity: "20", cost: "70" },
    ]);
    const receipt = await receiveOrder(session, po.id, { [elbow]: "450", [tape]: "20" });
    expect(receipt.totalPaise).toBe(1130000);
    const detail = await getPurchaseOrder(session, po.id);
    expect(detail.status).toBe("partially_received");
    expect(detail.lines.find((line) => line.productId === elbow)).toMatchObject({ receivedBase: "450", leftBase: "50", leftInUnit: "50" });
    await expect(receiveOrder(session, po.id, { [elbow]: "51" })).rejects.toMatchObject({ code: "OVER_RECEIPT" });
    await closePurchaseOrder(session, po.id, { reason: "Supplier out of stock" });
    expect((await getPurchaseOrder(session, po.id)).status).toBe("closed");
    await expect(receiveOrder(session, po.id, { [elbow]: "10" })).rejects.toMatchObject({ code: "ORDER_NOT_OPEN" });
  });

  it("S5: 94 pipes at ₹402, receive 180 at ₹410 → cost ₹407.26, with a cost history entry", async () => {
    const session = await owner();
    const pipe = await product(shopA, { cost: "402", stock: "94" });
    const receipt = await receiveGoods(session, { idempotencyKey: key(), supplierId: supreme, lines: [{ productId: pipe, unit: "pc", quantity: "180", cost: "410", gstRateBp: "0" }] });
    expect((await getProduct(session, pipe)).costPaise).toBe(40726);
    const history = await db.owner.select().from(productCostHistory).where(and(eq(productCostHistory.productId, pipe), eq(productCostHistory.sourceId, receipt.id)));
    expect(history).toEqual([expect.objectContaining({ costPaise: 40726, sourceType: "goods_receipt" })]);
  });
});

describe("receiving", () => {
  it("records GST input on a direct purchase and converts pack units to base units", async () => {
    const session = await owner();
    const fitting = await product(shopA, { box: "50", stock: "10" });
    const vendor = await supplier(shopA);
    // 3 boxes of 50 at ₹1,000 a box + 18% GST = ₹3,540; cost per piece ₹20.
    const receipt = await receiveGoods(session, { idempotencyKey: key(), supplierId: vendor, supplierBillNo: "A/77", supplierBillDate: indiaDate(), lines: [{ productId: fitting, unit: "box", quantity: "3", cost: "1000", gstRateBp: "1800" }] });
    expect(receipt.totalPaise).toBe(354000);
    expect(await stockOf(fitting)).toBe("160");
    expect(await owed(vendor)).toBe(354000);
    expect((await getProduct(session, fitting)).costPaise).toBe(2000);
  });

  it("refuses a supplier bill number entered twice for the same supplier, but not for another supplier", async () => {
    const session = await owner();
    const vendor = await supplier(shopA);
    const other = await supplier(shopA);
    const line = [{ productId: elbow, unit: "pc", quantity: "1", cost: "22", gstRateBp: "0" }];
    await receiveGoods(session, { idempotencyKey: key(), supplierId: vendor, supplierBillNo: "INV-55", lines: line });
    await expect(receiveGoods(session, { idempotencyKey: key(), supplierId: vendor, supplierBillNo: " inv-55 ", lines: line })).rejects.toMatchObject({ code: "DUPLICATE_SUPPLIER_BILL" });
    await expect(receiveGoods(session, { idempotencyKey: key(), supplierId: other, supplierBillNo: "INV-55", lines: line })).resolves.toHaveProperty("number");
  });

  it("returns the first receipt for a repeated submission", async () => {
    const session = await owner();
    const input = { idempotencyKey: key(), supplierId: supreme, lines: [{ productId: elbow, unit: "pc", quantity: "5", cost: "22", gstRateBp: "0" }] };
    const before = await stockOf(elbow);
    const first = await receiveGoods(session, input);
    const again = await receiveGoods(session, input);
    expect(again).toMatchObject({ id: first.id, replayed: true });
    expect(Number(await stockOf(elbow))).toBe(Number(before) + 5);
  });

  it("lets only one of two simultaneous receipts take the last expected units", async () => {
    const session = await owner();
    const po = await order(session, supreme, [{ productId: elbow, unit: "pc", quantity: "10", cost: "22" }]);
    const [line] = (await getPurchaseOrder(session, po.id)).lines;
    const attempt = () => receiveGoods(session, { idempotencyKey: key(), purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: line!.id, quantity: "7", cost: "22", gstRateBp: "0" }] });
    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "OVER_RECEIPT" } });
  });

  it("rolls everything back if a write fails part-way (number already taken)", async () => {
    const session = await owner();
    const pipe = await product(shopA, { cost: "100", stock: "10" });
    const vendor = await supplier(shopA);
    const [series] = await db.owner.execute<{ fy: string; next_value: number }>(sql`select fy, next_value from number_series where shop_id = ${shopA.shopId} and series = 'GRN' order by fy desc limit 1`).then((result) => result.rows);
    await db.owner.insert(goodsReceipts).values({ shopId: shopA.shopId, fy: series!.fy, number: `GRN/${series!.fy}/${String(series!.next_value).padStart(5, "0")}`, supplierId: vendor, receivedDate: indiaDate(), taxablePaise: 0, gstPaise: 0, totalPaise: 0, createdBy: shopA.users.owner.id });
    await expect(receiveGoods(session, { idempotencyKey: key(), supplierId: vendor, lines: [{ productId: pipe, unit: "pc", quantity: "10", cost: "200", gstRateBp: "0" }] })).rejects.toThrow();
    expect(await stockOf(pipe)).toBe("10");
    expect(await owed(vendor)).toBe(0);
    expect((await getProduct(session, pipe)).costPaise).toBe(10000);
    await db.owner.execute(sql`update number_series set next_value = next_value + 1 where shop_id = ${shopA.shopId} and series = 'GRN' and fy = ${series!.fy}`);
  });
});

describe("reversals", () => {
  it("cancelling a receipt takes the stock back out, reduces dues and reopens the order", async () => {
    const session = await owner();
    const vendor = await supplier(shopA);
    const po = await order(session, vendor, [{ productId: elbow, unit: "pc", quantity: "20", cost: "22" }]);
    const before = await stockOf(elbow);
    const receipt = await receiveOrder(session, po.id, { [elbow]: "20" }, { supplierBillNo: "R-1" });
    expect(await owed(vendor)).toBe(44000);
    await cancelGoodsReceipt(session, receipt.id, { reason: "Entered on the wrong supplier" });
    expect(await stockOf(elbow)).toBe(before);
    expect(await owed(vendor)).toBe(0);
    expect((await getPurchaseOrder(session, po.id)).status).toBe("ordered");
    await expect(cancelGoodsReceipt(session, receipt.id, { reason: "Again" })).rejects.toMatchObject({ code: "ALREADY_CANCELLED" });
    // The bill number is free again after cancelling.
    await expect(receiveOrder(session, po.id, { [elbow]: "20" }, { supplierBillNo: "R-1" })).resolves.toHaveProperty("number");
  });

  it("refuses cancelling a receipt whose goods were already used", async () => {
    const session = await owner();
    const item = await product(shopA, { cost: "50", stock: "1" });
    const receipt = await receiveGoods(session, { idempotencyKey: key(), supplierId: supreme, lines: [{ productId: item, unit: "pc", quantity: "5", cost: "50", gstRateBp: "0" }] });
    await recordAdjustment(session, { idempotencyKey: key(), productId: item, kind: "damage", unit: "pc", quantity: "5", reason: "Broken in store" });
    await expect(cancelGoodsReceipt(session, receipt.id, { reason: "Mistake" })).rejects.toMatchObject({ code: "STOCK_ALREADY_USED" });
  });

  it("cancels an order with nothing received, but not one with receipts", async () => {
    const session = await owner();
    const fresh = await order(session, supreme, [{ productId: elbow, unit: "pc", quantity: "5", cost: "22" }]);
    await cancelPurchaseOrder(session, fresh.id, { reason: "Ordered by mistake" });
    expect((await getPurchaseOrder(session, fresh.id)).status).toBe("cancelled");
    const used = await order(session, supreme, [{ productId: elbow, unit: "pc", quantity: "5", cost: "22" }]);
    await receiveOrder(session, used.id, { [elbow]: "2" });
    await expect(cancelPurchaseOrder(session, used.id, { reason: "x x x" })).rejects.toMatchObject({ code: "ORDER_HAS_RECEIPTS" });
  });
});

describe("supplier payments", () => {
  it("refuses paying more than owed, rejects duplicate references, and reverses a mistaken payment", async () => {
    const session = await owner();
    const vendor = await supplier(shopA, 500000);
    await expect(paySupplier(session, { idempotencyKey: key(), supplierId: vendor, amount: "5000.01", method: "cash" })).rejects.toMatchObject({ code: "OVERPAYMENT" });
    const paid = await paySupplier(session, { idempotencyKey: key(), supplierId: vendor, amount: "2000", method: "upi", reference: "UTR123" });
    expect(paid.owedAfterPaise).toBe(300000);
    await expect(paySupplier(session, { idempotencyKey: key(), supplierId: vendor, amount: "100", method: "upi", reference: "UTR123" })).rejects.toMatchObject({ code: "DUPLICATE_REFERENCE" });
    await reverseSupplierPayment(session, paid.id, { reason: "Typed the wrong amount" });
    expect(await owed(vendor)).toBe(500000);
    await expect(reverseSupplierPayment(session, paid.id, { reason: "Again" })).rejects.toMatchObject({ code: "ALREADY_REVERSED" });
    const detail = await getSupplier(session, vendor);
    expect(detail.owedPaise).toBe(500000);
    expect(detail.statement.at(-1)).toMatchObject({ owedAfterPaise: 500000 });
    expect(detail.payments.map((payment) => [payment.direction, payment.status]).sort()).toEqual([["in", "recorded"], ["out", "reversed"]]);
  });

  it("serialises simultaneous payments so the total never exceeds what is owed", async () => {
    const session = await owner();
    const vendor = await supplier(shopA, 100000);
    const pay = () => paySupplier(session, { idempotencyKey: key(), supplierId: vendor, amount: "700", method: "cash" });
    const results = await Promise.allSettled([pay(), pay()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await owed(vendor)).toBe(30000);
  });

  it("lists suppliers with what is owed to each", async () => {
    const list = await listSuppliers(await owner());
    expect(list.find((row) => row.id === supreme)?.owedPaise).toBe(await owed(supreme));
  });
});

describe("permissions and isolation", () => {
  it("inventory staff receive goods but can't pay or cancel; cashiers can't see purchases", async () => {
    const { session: inventory } = await signInAs(shopA.users.inventory);
    const receipt = await receiveGoods(inventory, { idempotencyKey: key(), supplierId: supreme, lines: [{ productId: elbow, unit: "pc", quantity: "1", cost: "22", gstRateBp: "0" }] });
    await expect(paySupplier(inventory, { idempotencyKey: key(), supplierId: supreme, amount: "1", method: "cash" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(cancelGoodsReceipt(inventory, receipt.id, { reason: "Mistake" })).rejects.toBeInstanceOf(ForbiddenError);
    const { session: manager } = await signInAs(shopA.users.manager);
    await expect(paySupplier(manager, { idempotencyKey: key(), supplierId: supreme, amount: "1", method: "cash" })).rejects.toBeInstanceOf(ForbiddenError);
    const { session: cashier } = await signInAs(shopA.users.cashier);
    await expect(listSuppliers(cashier)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(receiveGoods(cashier, { idempotencyKey: key(), supplierId: supreme, lines: [{ productId: elbow, unit: "pc", quantity: "1", cost: "22", gstRateBp: "0" }] })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("never touches another shop's suppliers, products, orders or receipts", async () => {
    const theirSupplier = await supplier(shopB, 100000);
    const theirProduct = await product(shopB, { stock: "5" });
    const theirOrder = await order(await owner(shopB), theirSupplier, [{ productId: theirProduct, unit: "pc", quantity: "5", cost: "10" }]);
    const theirReceipt = await receiveGoods(await owner(shopB), { idempotencyKey: key(), supplierId: theirSupplier, lines: [{ productId: theirProduct, unit: "pc", quantity: "1", cost: "10", gstRateBp: "0" }] });
    const session = await owner();
    await expect(getSupplier(session, theirSupplier)).rejects.toBeInstanceOf(NotFoundError);
    await expect(receiveGoods(session, { idempotencyKey: key(), supplierId: theirSupplier, lines: [{ productId: elbow, unit: "pc", quantity: "1", cost: "22", gstRateBp: "0" }] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(receiveGoods(session, { idempotencyKey: key(), supplierId: supreme, lines: [{ productId: theirProduct, unit: "pc", quantity: "1", cost: "22", gstRateBp: "0" }] })).rejects.toMatchObject({ details: { fieldErrors: { "lines.0.productId": "Product not found." } } });
    await expect(getPurchaseOrder(session, theirOrder.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(cancelGoodsReceipt(session, theirReceipt.id, { reason: "Not mine" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(paySupplier(session, { idempotencyKey: key(), supplierId: theirSupplier, amount: "1", method: "cash" })).rejects.toBeInstanceOf(NotFoundError);
    expect(await owed(theirSupplier, shopB)).toBe(101000);
  });
});
