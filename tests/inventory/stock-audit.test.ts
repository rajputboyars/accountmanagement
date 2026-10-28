import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { addProductUnit, createProduct } from "@/modules/catalog";
import { getProductStock, listStock, recordAdjustment, recordOpeningStock, stockAlerts } from "@/modules/inventory";
import { stockLevels, stockMovements } from "@/modules/inventory/schema";
import { createCustomer } from "@/modules/parties";
import { createSupplier, receiveGoods } from "@/modules/purchasing";
import { getDashboard } from "@/modules/reporting";
import { cancelInvoice, createInvoice, createReturn, getReturnableInvoice, previewBill, previewReturn, type BillInput } from "@/modules/sales";
import { NotFoundError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { createTestShop, signInAs } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

/**
 * Stock through every workflow that moves it: each document writes its movement exactly once, the
 * cache equals the journal, and the product page, stock list, alerts and dashboard agree.
 */
const db = setupTestDatabase();
type Session = Awaited<ReturnType<typeof signInAs>>["session"];
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
let n = 0;

async function setup() {
  n += 1;
  const shop = await createTestShop(db, `Stock audit ${n}`);
  const session = (await signInAs(shop.users.owner)).session;
  return { shop, session };
}
async function product(session: Session, extra: { baseUnit?: string; box?: string; reorder?: number } = {}) {
  n += 1;
  const { id } = await createProduct(session, { name: `Valve ${n}`, sku: `SA-${n}`, baseUnit: extra.baseUnit ?? "pc", hsn: "8481", gstRateBp: "0", retailPaise: "10", wholesalePaise: "9", costPaise: "6" });
  if (extra.box) await addProductUnit(session, id, { unit: "box", factor: extra.box });
  if (extra.reorder !== undefined) await db.owner.execute(`update products set reorder_level = ${extra.reorder} where id = '${id}'`);
  return id;
}
async function sell(session: Session, input: BillInput) {
  const preview = await previewBill(session, input);
  return createInvoice(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}
async function journal(productId: string) {
  const rows = await db.owner.select({ kind: stockMovements.kind, sourceType: stockMovements.sourceType, qty: stockMovements.qtyBase }).from(stockMovements).where(eq(stockMovements.productId, productId));
  const [cache] = await db.owner.select().from(stockLevels).where(eq(stockLevels.productId, productId));
  const total = rows.reduce((sum, row) => sum + Number(row.qty), 0);
  expect(Number(cache?.qtyBase ?? 0)).toBe(total); // cache = SUM(movements)
  return { rows, total };
}

describe("stock audit", () => {
  it("moves stock exactly once per purchase, sale, cancellation, return and adjustment, in boxes or pieces", async () => {
    const { session } = await setup();
    const id = await product(session, { box: "25", reorder: 30 });
    const { id: supplierId } = await createSupplier(session, { name: `Supplier ${n}`, phone: "9000005005", paymentTermsDays: "30" });
    const receipt = { idempotencyKey: key(), supplierId, lines: [{ productId: id, unit: "box", quantity: "4", cost: "150", gstRateBp: "0" }] };
    await Promise.all([receiveGoods(session, receipt), receiveGoods(session, receipt)]); // double submit
    expect((await getProductStock(session, id)).qty).toBe("100");

    const cash = await sell(session, { lines: [{ productId: id, unit: "box", quantity: "2" }], payments: { cash: "500" } }); // 50 pc
    const buyer = (await createCustomer(session, { name: `Buyer ${n}`, phone: String(9700000000 + n), type: "retail", creditLimit: "100000" })).id;
    const partPaid = await sell(session, { customerId: buyer, lines: [{ productId: id, unit: "pc", quantity: "10" }], payments: { cash: "40" } }); // ₹100, ₹40 paid
    expect((await getProductStock(session, id)).qty).toBe("40");

    await cancelInvoice(session, partPaid.id, { reason: "Wrong items" });
    expect((await getProductStock(session, id)).qty).toBe("50");
    const [line] = (await getReturnableInvoice(session, cash.id)).lines;
    const ret = { invoiceId: cash.id, lines: [{ invoiceLineId: line!.id, baseQty: "5", restock: true }], reason: "Extra", settlement: "cash" as const };
    await createReturn(session, { ...ret, idempotencyKey: key(), expectedTotalPaise: (await previewReturn(session, ret)).totalPaise });
    expect((await getProductStock(session, id)).qty).toBe("55");
    await recordAdjustment(session, { idempotencyKey: key(), productId: id, kind: "damage", unit: "pc", quantity: "20", reason: "Cracked in transit" });

    const { rows, total } = await journal(id);
    expect(total).toBe(35);
    const count = (kind: string) => rows.filter((row) => row.kind === kind).length;
    expect({ purchase: count("purchase"), sale: count("sale"), cancel: count("sale_cancel"), adjust: rows.filter((row) => row.sourceType === "stock_adjustment").length }).toEqual({ purchase: 1, sale: 2, cancel: 1, adjust: 1 });
    expect(rows.length).toBe(6); // + one return movement
    const page = await getProductStock(session, id);
    expect(page.qty).toBe("35");
    expect(page.movements.reduce((sum, movement) => sum + Number(movement.qty), 0)).toBe(35); // history adds up to what is shown
  });

  it("agrees across the product page, stock list, low-stock alerts and dashboard", async () => {
    const { session } = await setup();
    const low = await product(session, { reorder: 20 });
    const out = await product(session, { reorder: 5 });
    const fine = await product(session, { reorder: 5 });
    await recordOpeningStock(session, { idempotencyKey: key(), movementDate: today, lines: [{ productId: low, unit: "pc", quantity: "12" }, { productId: out, unit: "pc", quantity: "3" }, { productId: fine, unit: "pc", quantity: "50" }] });
    await sell(session, { lines: [{ productId: out, unit: "pc", quantity: "3" }], payments: { cash: "30" } });

    const alerts = await stockAlerts(session, 10);
    const list = await listStock(session, {});
    const dash = await getDashboard(session);
    for (const id of [low, out, fine]) {
      const page = await getProductStock(session, id);
      const row = list.items.find((item) => item.productId === id);
      expect(row).toMatchObject({ qty: page.qty, status: page.status });
    }
    expect((await getProductStock(session, out)).status).toBe("out");
    expect(alerts.items.map((item) => item.productId).sort()).toEqual([low, out].sort());
    expect(alerts.items.find((item) => item.productId === fine)).toBeUndefined();
    expect(dash.stock?.counts).toEqual(alerts.counts);
    expect(list.counts).toEqual(alerts.counts);
  });

  it("never oversells when a sale and an adjustment race for the last units", async () => {
    const { session } = await setup();
    const id = await product(session);
    await recordOpeningStock(session, { idempotencyKey: key(), movementDate: today, lines: [{ productId: id, unit: "pc", quantity: "5" }] });
    const input: BillInput = { lines: [{ productId: id, unit: "pc", quantity: "5" }], payments: { cash: "50" } };
    const preview = await previewBill(session, input);
    const results = await Promise.allSettled([
      createInvoice(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates }),
      recordAdjustment(session, { idempotencyKey: key(), productId: id, kind: "damage", unit: "pc", quantity: "5", reason: "Broken" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const { total } = await journal(id);
    expect(total).toBe(0);
    const [negative] = await db.owner.select({ n: sql<number>`count(*)::int` }).from(stockLevels).where(sql`${stockLevels.qtyBase} < 0`);
    expect(negative?.n).toBe(0);
  });

  it("handles decimal units exactly and refuses fractions of a piece, bad values and too little stock", async () => {
    const { session } = await setup();
    const pipe = await product(session, { baseUnit: "m" });
    const tap = await product(session);
    await recordOpeningStock(session, { idempotencyKey: key(), movementDate: today, lines: [{ productId: pipe, unit: "m", quantity: "10.5" }, { productId: tap, unit: "pc", quantity: "3" }] });
    await sell(session, { lines: [{ productId: pipe, unit: "m", quantity: "2.25" }], payments: { cash: "23" } }); // ₹22.50 rounds to ₹23 on the bill
    expect((await getProductStock(session, pipe)).qty).toBe("8.25");
    for (const quantity of ["1.5", "0", "-1", "abc"]) {
      await expect(previewBill(session, { lines: [{ productId: tap, unit: "pc", quantity }] }).then((p) => (p.problems.length ? Promise.reject(p.problems) : p)), quantity).rejects.toBeTruthy();
    }
    await expect(recordAdjustment(session, { idempotencyKey: key(), productId: pipe, kind: "damage", unit: "m", quantity: "1.2345", reason: "Cut wrong" })).rejects.toBeTruthy();
    const short = await previewBill(session, { lines: [{ productId: tap, unit: "pc", quantity: "4" }], payments: { cash: "40" } });
    expect(short.problems).toEqual([expect.objectContaining({ code: "INSUFFICIENT_STOCK" })]);
    expect((await journal(tap)).total).toBe(3);
  });

  it("keeps each shop's products and stock to itself", async () => {
    const a = await setup();
    const b = await setup();
    const id = await product(a.session);
    await recordOpeningStock(a.session, { idempotencyKey: key(), movementDate: today, lines: [{ productId: id, unit: "pc", quantity: "7" }] });
    await expect(getProductStock(b.session, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordAdjustment(b.session, { idempotencyKey: key(), productId: id, kind: "damage", unit: "pc", quantity: "1", reason: "Not mine" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordOpeningStock(b.session, { idempotencyKey: key(), movementDate: today, lines: [{ productId: id, unit: "pc", quantity: "1" }] })).rejects.toBeTruthy();
    await expect(sell(b.session, { lines: [{ productId: id, unit: "pc", quantity: "1" }], payments: { cash: "10" } })).rejects.toBeTruthy();
    expect((await listStock(b.session, {})).items).toEqual([]);
    expect((await stockAlerts(b.session, 10)).items).toEqual([]);
    expect((await getProductStock(a.session, id)).qty).toBe("7");
  });
});
