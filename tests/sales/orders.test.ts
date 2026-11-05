import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accountBalances, activateBusinessAccounts } from "@/modules/accounting";
import { addProductUnit, createProduct, getProduct, updateProduct } from "@/modules/catalog";
import { createGodown, godownStock, listGodowns, recordAdjustment, transferStock } from "@/modules/inventory";
import { createCustomer } from "@/modules/parties";
import { createSupplier } from "@/modules/purchasing";
import {
  cancelDeliveryChallan,
  cancelInvoice,
  cancelSalesOrder,
  closeSalesOrder,
  confirmSalesOrder,
  createDeliveryChallan,
  createInvoice,
  createReturn,
  createSalesOrder,
  getReturnableInvoice,
  getSalesOrder,
  listBillableDeliveries,
  previewBill,
  previewReturn,
  reserveOrderStock,
  type BillInput,
} from "@/modules/sales";
import { invoiceChallanLinks, invoices, invoiceLines } from "@/modules/sales/schema";
import { stockMovements } from "@/modules/inventory/schema";
import { toActionError } from "@/server/action-result";
import { indiaDate } from "@/shared/financial-year";
import { addDays } from "@/shared/report-range";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { receiveGoods } from "../helpers/purchasing";
import { setupTestDatabase } from "../helpers/test-db";

/** Sales orders, reservations, delivery challans and bills made from delivered goods. */
const db = setupTestDatabase();
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
let counter = 0;
const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error, "should be refused").not.toBeNull();
  return (await toActionError(error)).error;
};
const as = async (shop: TestShop, role: keyof TestShop["users"] = "owner") => (await signInAs(shop.users[role])).session;

/** A shop with books on, 100 pieces of a pipe (₹60 each, sold also by the box of 12) in stock, and a registered customer. */
async function setup(options: { stock?: string } = {}) {
  const shop = await createTestShop(db, `Orders shop ${++counter}`);
  const owner = await as(shop);
  await activateBusinessAccounts(owner, { coverageStartDate: addDays(today, -10) });
  const pipe = (await createProduct(owner, { name: `Pipe ${counter}`, sku: `OR-${counter}`, baseUnit: "pc", hsn: "3917", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "" })).id;
  await addProductUnit(owner, pipe, { unit: "box", factor: "12" });
  const supplier = (await createSupplier(owner, { name: `Supplier ${counter}`, phone: "", gstin: "", paymentTermsDays: "30" })).id;
  const stock = async (quantity: string) => receiveGoods(owner, { idempotencyKey: key(), supplierId: supplier, supplierBillNo: `OB-${++counter}`, supplierBillDate: today, lines: [{ productId: pipe, unit: "pc", quantity, cost: "60", gstRateBp: "0" }] });
  await stock(options.stock ?? "100");
  const customer = (await createCustomer(owner, { name: `Buyer ${counter}`, phone: String(9500000000 + counter), type: "retail", creditLimit: "1000000" })).id;
  return { shop, owner, pipe, supplier, customer, stock };
}
type World = Awaited<ReturnType<typeof setup>>;

const order = (w: World, quantity: string, extra: Record<string, unknown> = {}) => createSalesOrder(w.owner, { idempotencyKey: key(), customerId: w.customer, confirm: true, lines: [{ productId: w.pipe, unit: "pc", quantity }], ...extra });
const deliver = async (w: World, orderId: string, quantity: string, extra: Record<string, unknown> = {}) => {
  const detail = await getSalesOrder(w.owner, orderId);
  return createDeliveryChallan(w.owner, { idempotencyKey: key(), orderId, lines: [{ orderLineId: detail.lines[0]!.id, quantity }], ...extra });
};
const physical = async (w: World) => Number((await godownStock(w.owner, { productId: w.pipe })).reduce((sum, row) => sum + Number(row.qty), 0));
const movements = async (w: World, kind?: string) => (await db.owner.select().from(stockMovements).where(eq(stockMovements.productId, w.pipe))).filter((row) => !kind || row.kind === kind);
const books = async (w: World) => Object.fromEntries((await accountBalances(w.owner)).map((row) => [row.systemKey, row.debitPaise - row.creditPaise]));

/** A bill for goods already delivered: the server builds the lines from the chosen delivered lines. */
async function billDelivered(w: World, orderId: string, picks: { challanLineId: string; quantity: string }[], extra: Partial<BillInput> & Record<string, unknown> = {}) {
  const detail = await getSalesOrder(w.owner, orderId);
  const input = { customerId: w.customer, lines: picks.map((pick) => ({ productId: w.pipe, unit: detail.lines[0]!.unit, quantity: pick.quantity })), payments: { cash: "0" }, challanLines: picks, ...extra };
  const preview = await previewBill(w.owner, input);
  return { preview, input, saved: preview.problems.length === 0 ? await createInvoice(w.owner, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates }) : null };
}
const challanLinesOf = async (w: World, orderId: string) => (await listBillableDeliveries(w.owner, orderId)).lines;

describe("orders and reservations", () => {
  it("reserves stock without moving it, and direct sales and transfers can only use what is not set aside", async () => {
    const w = await setup();
    const o = await order(w, "30");
    expect(await physical(w)).toBe(100);
    expect(await movements(w, "sale")).toHaveLength(0);
    const detail = await getSalesOrder(w.owner, o.id);
    expect(detail).toMatchObject({ status: "confirmed" });
    expect(detail.lines[0]).toMatchObject({ orderedBase: "30", reservedBase: "30", pendingBase: "30", shortBase: "0", deliveredBase: "0" });
    // 100 on hand, 30 set aside: a direct bill for 80 is refused, 70 is fine.
    const over = await previewBill(w.owner, { lines: [{ productId: w.pipe, unit: "pc", quantity: "80" }], payments: { cash: "8000" } });
    expect(over.problems.map((problem) => problem.code)).toContain("INSUFFICIENT_STOCK");
    const ok = await previewBill(w.owner, { lines: [{ productId: w.pipe, unit: "pc", quantity: "70" }], payments: { cash: "7000" } });
    expect(ok.problems).toEqual([]);
    // Transfers and write-offs respect it too.
    const floor = (await createGodown(w.owner, { name: "Shop floor" })).id;
    const [main] = await listGodowns(w.owner);
    expect(await refusal(transferStock(w.owner, { idempotencyKey: key(), fromGodownId: main!.id, toGodownId: floor, lines: [{ productId: w.pipe, unit: "pc", quantity: "80" }] }))).toMatch(/Only 70 pc/);
    await transferStock(w.owner, { idempotencyKey: key(), fromGodownId: main!.id, toGodownId: floor, lines: [{ productId: w.pipe, unit: "pc", quantity: "70" }] });
    expect(await refusal(recordAdjustment(w.owner, { idempotencyKey: key(), productId: w.pipe, godownId: main!.id, kind: "damage", unit: "pc", quantity: "5", reason: "Broken in storage" }))).toMatch(/set aside for orders/);
  });

  it("shows reserved versus pending when stock is short, and reserves the rest when stock arrives", async () => {
    const w = await setup({ stock: "100" });
    const o = await order(w, "120");
    let line = (await getSalesOrder(w.owner, o.id)).lines[0]!;
    expect(line).toMatchObject({ orderedBase: "120", reservedBase: "100", pendingBase: "120", shortBase: "20" });
    await w.stock("30");
    expect(await reserveOrderStock(w.owner, o.id)).toEqual({ reservedLines: 1 });
    line = (await getSalesOrder(w.owner, o.id)).lines[0]!;
    expect(line).toMatchObject({ reservedBase: "120", shortBase: "0" });
    expect(await physical(w)).toBe(130);
  });

  it("is a draft until confirmed, cancels and releases the reservation, and is idempotent", async () => {
    const w = await setup();
    const request = { idempotencyKey: key(), customerId: w.customer, lines: [{ productId: w.pipe, unit: "box", quantity: "2" }] };
    const draft = await createSalesOrder(w.owner, request);
    expect(await createSalesOrder(w.owner, request)).toMatchObject({ id: draft.id, replayed: true });
    expect((await getSalesOrder(w.owner, draft.id)).status).toBe("draft");
    expect((await getSalesOrder(w.owner, draft.id)).lines[0]).toMatchObject({ orderedQty: "2", orderedBase: "24", reservedBase: "0", unit: "box", factor: "12" });
    await confirmSalesOrder(w.owner, draft.id);
    expect((await getSalesOrder(w.owner, draft.id)).lines[0]!.reservedBase).toBe("24");
    expect(await refusal(confirmSalesOrder(w.owner, draft.id))).toBe("This order is already confirmed.");
    await cancelSalesOrder(w.owner, draft.id, { reason: "Customer changed mind" });
    expect(await getSalesOrder(w.owner, draft.id)).toMatchObject({ status: "cancelled" });
    const open = await previewBill(w.owner, { lines: [{ productId: w.pipe, unit: "pc", quantity: "100" }], payments: { cash: "10000" } });
    expect(open.problems).toEqual([]);
    expect(await refusal(createSalesOrder(w.owner, { idempotencyKey: key(), customerId: w.customer, lines: [{ productId: w.pipe, unit: "pc", quantity: "1" }, { productId: w.pipe, unit: "pc", quantity: "2" }] }))).toMatch(/already on line 1/);
  });
});

describe("delivery challans", () => {
  it("deducts physical stock exactly once, supports several partial deliveries and never more than is pending", async () => {
    const w = await setup();
    const o = await order(w, "30");
    const first = await deliver(w, o.id, "10");
    expect(first.number).toMatch(/^DC\//);
    expect(await physical(w)).toBe(90);
    expect(await movements(w, "delivery")).toHaveLength(1);
    expect(await getSalesOrder(w.owner, o.id)).toMatchObject({ status: "partially_delivered" });
    const detail = await getSalesOrder(w.owner, o.id);
    expect(detail.lines[0]).toMatchObject({ deliveredBase: "10", reservedBase: "20", pendingBase: "20" });
    expect(await refusal(deliver(w, o.id, "21"))).toBe(`Only 20 pc of ${detail.lines[0]!.productName} is still to be delivered on this order.`);
    await deliver(w, o.id, "20");
    expect(await physical(w)).toBe(70);
    expect(await getSalesOrder(w.owner, o.id)).toMatchObject({ status: "delivered" });
    expect((await getSalesOrder(w.owner, o.id)).lines[0]!.reservedBase).toBe("0");
    expect(await refusal(deliver(w, o.id, "1"))).toBe("Nothing more can be delivered against this order.");
    // A repeat of the same request is the same delivery.
    const request = { idempotencyKey: key(), orderId: (await order(w, "5")).id };
    const lineId = (await getSalesOrder(w.owner, request.orderId)).lines[0]!.id;
    const a = await createDeliveryChallan(w.owner, { ...request, lines: [{ orderLineId: lineId, quantity: "5" }] });
    const b = await createDeliveryChallan(w.owner, { ...request, lines: [{ orderLineId: lineId, quantity: "5" }] });
    expect(b).toMatchObject({ id: a.id, replayed: true });
    expect(await movements(w, "delivery")).toHaveLength(3);
  });

  it("keeps the unit and factor it was ordered in, delivers from a godown that must be chosen once there are several, and posts delivered-not-billed", async () => {
    const w = await setup();
    const floor = (await createGodown(w.owner, { name: "Shop floor" })).id;
    const [main] = await listGodowns(w.owner);
    const o = await order(w, "2", { godownId: main!.id, lines: [{ productId: w.pipe, unit: "box", quantity: "2" }] });
    expect(await refusal(deliver(w, o.id, "1"))).toBe("Choose which godown the stock comes from.");
    const before = await books(w);
    const challan = await deliver(w, o.id, "1", { godownId: main!.id });
    const [move] = await movements(w, "delivery");
    expect(move).toMatchObject({ godownId: main!.id, qtyBase: "-12.000", enteredQty: "1.000", enteredUnit: "box", enteredFactor: "12.000", unitCostPaise: 6000 });
    expect(challan.id).toBeDefined();
    const after = await books(w);
    expect(after.delivered_not_billed).toBe((before.delivered_not_billed ?? 0) + 12 * 6000);
    expect(after.inventory).toBe(before.inventory - 12 * 6000);
    expect(after.cogs ?? 0).toBe(before.cogs ?? 0);
    expect(await refusal(deliver(w, o.id, "1", { godownId: floor }))).toMatch(/can be delivered from here/);
  });

  it("delivers a reserved godown's stock only from reserved or free stock and never takes what other orders hold", async () => {
    const w = await setup({ stock: "10" });
    const a = await order(w, "6");
    const b = await order(w, "6"); // only 4 can be reserved
    expect((await getSalesOrder(w.owner, b.id)).lines[0]).toMatchObject({ reservedBase: "4", shortBase: "2" });
    // The second order can only take what is free: nothing beyond its own 4 (the other 6 belong to order A).
    expect(await refusal(deliver(w, b.id, "5"))).toMatch(/Only 4 pc/);
    await deliver(w, b.id, "4");
    await deliver(w, a.id, "6");
    expect(await physical(w)).toBe(0);
    expect((await db.owner.execute(sql`select count(*)::int as n from stock_levels where qty_base < 0`)).rows[0]).toMatchObject({ n: 0 });
  });

  it("closes a part-delivered order and releases what is left; an order with deliveries cannot be cancelled", async () => {
    const w = await setup();
    const o = await order(w, "30");
    await deliver(w, o.id, "10");
    expect(await refusal(cancelSalesOrder(w.owner, o.id, { reason: "Changed mind" }))).toMatch(/can't be cancelled/);
    await closeSalesOrder(w.owner, o.id, { reason: "Customer took less" });
    const detail = await getSalesOrder(w.owner, o.id);
    expect(detail).toMatchObject({ status: "delivered" });
    expect(detail.lines[0]).toMatchObject({ reservedBase: "0", pendingBase: "0" });
    expect((await previewBill(w.owner, { lines: [{ productId: w.pipe, unit: "pc", quantity: "90" }], payments: { cash: "9000" } })).problems).toEqual([]);
  });
});

describe("bills made from delivered goods", () => {
  it("bills partial amounts in several bills without moving stock, cannot bill more than delivered, and moves cost through delivered-not-billed into cost of goods sold", async () => {
    const w = await setup();
    const o = await order(w, "30");
    await deliver(w, o.id, "10");
    const stockBefore = await movements(w);
    const [line] = await challanLinesOf(w, o.id);
    expect(line).toMatchObject({ deliveredQty: "10", remainingQty: "10" });
    const books0 = await books(w);
    const first = await billDelivered(w, o.id, [{ challanLineId: line!.challanLineId, quantity: "6" }]);
    expect(first.preview.problems).toEqual([]);
    expect(first.saved).not.toBeNull();
    // No stock moved for the bill; it is linked to the delivered goods and flagged.
    expect(await movements(w)).toHaveLength(stockBefore.length);
    expect(await physical(w)).toBe(90);
    const [invoice] = await db.owner.select().from(invoices).where(eq(invoices.id, first.saved!.id));
    expect(invoice).toMatchObject({ fromChallans: true, totalPaise: 60000 });
    const [row] = await db.owner.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice!.id));
    expect(row).toMatchObject({ unitCostPaise: 6000, baseQty: "6.000" });
    // Books: 6 x ₹60 left delivered-not-billed and became cost of goods sold; sales were posted by the bill.
    const books1 = await books(w);
    expect(books1.cogs - (books0.cogs ?? 0)).toBe(6 * 6000);
    expect(books1.delivered_not_billed - books0.delivered_not_billed).toBe(-6 * 6000);
    expect(books1.inventory).toBe(books0.inventory);
    expect(books1.sales).toBe((books0.sales ?? 0) - 60000);
    // Only 4 are left to bill; 5 is refused, 4 is fine, and then nothing remains.
    expect(await refusal(billDelivered(w, o.id, [{ challanLineId: line!.challanLineId, quantity: "5" }]))).toBe("More than was delivered and not yet billed. Check the quantities.");
    expect((await billDelivered(w, o.id, [{ challanLineId: line!.challanLineId, quantity: "4" }])).saved).not.toBeNull();
    expect(await challanLinesOf(w, o.id)).toEqual([]);
  });

  it("uses the cost the goods left at, not today's cost, and shows the order's price beside the bill's", async () => {
    const w = await setup();
    const o = await order(w, "10");
    await deliver(w, o.id, "10");
    // The shop's cost and selling price change between delivery and billing.
    const current = await getProduct(w.owner, w.pipe);
    await updateProduct(w.owner, w.pipe, { name: current.name, sku: current.sku, baseUnit: "pc", hsn: "3917", gstRateBp: "0", retailPaise: "120", wholesalePaise: "90", costPaise: "99", categoryName: "", description: "", barcode: "", reorderLevel: "", version: current.version });
    const [line] = await challanLinesOf(w, o.id);
    expect(line!.indicativeRatePaise).toBe(10000);
    const bill = await billDelivered(w, o.id, [{ challanLineId: line!.challanLineId, quantity: "10" }]);
    expect(bill.preview.lines[0]!.ratePaise).toBe(12000);
    const [row] = await db.owner.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, bill.saved!.id));
    expect(row!.unitCostPaise).toBe(6000);
  });

  it("cancelling the bill reverses the money and releases the links but puts no stock back; the goods can be billed again", async () => {
    const w = await setup();
    const o = await order(w, "10");
    await deliver(w, o.id, "10");
    const [line] = await challanLinesOf(w, o.id);
    const before = await books(w);
    const stockMoves = (await movements(w)).length;
    const bill = await billDelivered(w, o.id, [{ challanLineId: line!.challanLineId, quantity: "10" }]);
    await cancelInvoice(w.owner, bill.saved!.id, { reason: "Wrong customer" });
    expect(await physical(w)).toBe(90);
    expect((await movements(w)).length).toBe(stockMoves);
    const links = await db.owner.select().from(invoiceChallanLinks).where(eq(invoiceChallanLinks.invoiceId, bill.saved!.id));
    expect(links.every((link) => link.releasedAt !== null)).toBe(true);
    const after = await books(w);
    expect(after.cogs ?? 0).toBe(before.cogs ?? 0);
    expect(after.delivered_not_billed).toBe(before.delivered_not_billed);
    expect(after.sales ?? 0).toBe(before.sales ?? 0);
    expect((await challanLinesOf(w, o.id))[0]).toMatchObject({ remainingQty: "10" });
    expect((await billDelivered(w, o.id, [{ challanLineId: line!.challanLineId, quantity: "10" }])).saved).not.toBeNull();
  });

  it("cancels only unbilled deliveries, putting stock back into the godown it left and reversing the books", async () => {
    const w = await setup();
    const floor = (await createGodown(w.owner, { name: "Shop floor" })).id;
    const [main] = await listGodowns(w.owner);
    await transferStock(w.owner, { idempotencyKey: key(), fromGodownId: main!.id, toGodownId: floor, lines: [{ productId: w.pipe, unit: "pc", quantity: "40" }] });
    const o = await order(w, "20", { godownId: floor });
    const before = await books(w);
    const delivery = await deliver(w, o.id, "20", { godownId: floor });
    expect((await godownStock(w.owner, { godownId: floor, productId: w.pipe }))[0]!.qty).toBe("20.000");
    const [line] = await challanLinesOf(w, o.id);
    const bill = await billDelivered(w, o.id, [{ challanLineId: line!.challanLineId, quantity: "5" }]);
    expect(await refusal(cancelDeliveryChallan(w.owner, delivery.id, { reason: "Wrong goods" }))).toBe("Some of these goods were already billed, so the delivery can't be cancelled. Cancel the bill first.");
    await expect(cancelDeliveryChallan(await as(w.shop, "cashier"), delivery.id, { reason: "Wrong goods" })).rejects.toThrow();
    await cancelInvoice(w.owner, bill.saved!.id, { reason: "Cancelled" });
    await cancelDeliveryChallan(w.owner, delivery.id, { reason: "Wrong goods" });
    // Back in the shop floor, not the Main Store; books as before; order open again.
    expect((await godownStock(w.owner, { godownId: floor, productId: w.pipe }))[0]!.qty).toBe("40.000");
    expect((await godownStock(w.owner, { godownId: main!.id, productId: w.pipe }))[0]!.qty).toBe("60.000");
    const after = await books(w);
    expect(after.delivered_not_billed ?? 0).toBe(before.delivered_not_billed ?? 0);
    expect(after.inventory).toBe(before.inventory);
    expect((await getSalesOrder(w.owner, o.id)).status).toBe("confirmed");
    expect(await refusal(cancelDeliveryChallan(w.owner, delivery.id, { reason: "Again" }))).toBe("This delivery is already cancelled.");
  });

  it("sends returned goods back to the godown they were delivered from", async () => {
    const w = await setup();
    const floor = (await createGodown(w.owner, { name: "Shop floor" })).id;
    const [main] = await listGodowns(w.owner);
    await transferStock(w.owner, { idempotencyKey: key(), fromGodownId: main!.id, toGodownId: floor, lines: [{ productId: w.pipe, unit: "pc", quantity: "30" }] });
    const o = await order(w, "10", { godownId: floor });
    await deliver(w, o.id, "10", { godownId: floor });
    const [line] = await challanLinesOf(w, o.id);
    const bill = await billDelivered(w, o.id, [{ challanLineId: line!.challanLineId, quantity: "10" }], { payments: { cash: "1000" } });
    const [returnable] = (await getReturnableInvoice(w.owner, bill.saved!.id)).lines;
    const ret = { invoiceId: bill.saved!.id, lines: [{ invoiceLineId: returnable!.id, baseQty: "4", restock: true }], reason: "Extra", settlement: "cash" as const };
    await createReturn(w.owner, { ...ret, idempotencyKey: key(), expectedTotalPaise: (await previewReturn(w.owner, ret)).totalPaise });
    expect((await godownStock(w.owner, { godownId: floor, productId: w.pipe }))[0]!.qty).toBe("24.000"); // 30 - 10 + 4
    expect((await godownStock(w.owner, { godownId: main!.id, productId: w.pipe }))[0]!.qty).toBe("70.000");
  });
});

describe("rules around orders", () => {
  it("lets cashiers raise orders but keeps orders and deliveries inside the shop", async () => {
    const w = await setup();
    const cashier = await as(w.shop, "cashier");
    const o = await createSalesOrder(cashier, { idempotencyKey: key(), customerId: w.customer, confirm: true, lines: [{ productId: w.pipe, unit: "pc", quantity: "3" }] });
    expect(o.number).toMatch(/^SO\//);
    const other = await createTestShop(db, "Other orders shop");
    expect(await refusal(getSalesOrder(await as(other), o.id))).toBe("Order not found.");
    expect(await refusal(confirmSalesOrder(await as(other), o.id))).toBe("Order not found.");
    await expect(createSalesOrder(await as(w.shop, "inventory"), { idempotencyKey: key(), customerId: w.customer, lines: [{ productId: w.pipe, unit: "pc", quantity: "1" }] })).rejects.toThrow();
  });

  it("never lets two orders reserve the same last units, however they race", async () => {
    const w = await setup({ stock: "10" });
    const results = await Promise.all([order(w, "10"), order(w, "10")]);
    const lines = await Promise.all(results.map(async (result) => (await getSalesOrder(w.owner, result.id)).lines[0]!));
    expect(lines.map((line) => Number(line.reservedBase)).sort((a, b) => a - b)).toEqual([0, 10]);
    expect(lines.map((line) => Number(line.shortBase)).sort((a, b) => a - b)).toEqual([0, 10]);
  });
});
