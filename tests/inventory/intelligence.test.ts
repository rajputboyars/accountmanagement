import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createProduct } from "@/modules/catalog";
import { appendStockMovement, recordOpeningStock, stockNotSelling } from "@/modules/inventory";
import { stockMovements } from "@/modules/inventory/schema";
import { createSupplier } from "@/modules/purchasing";
import { withTransaction } from "@/server/db";
import { cancelInvoice, createInvoice, previewBill, type BillInput } from "@/modules/sales";
import { indiaDate } from "@/shared/financial-year";
import { addDays } from "@/shared/report-range";
import { createTestShop, signInAs } from "../helpers/factories";
import { receiveGoods } from "../helpers/purchasing";
import { setupTestDatabase } from "../helpers/test-db";

/** Stock Not Selling against real movements: last-sold is exact, age is an estimate, unknown stays unknown, and costs follow the viewer's permission. */
const db = setupTestDatabase();
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();
type Session = Awaited<ReturnType<typeof signInAs>>["session"];

async function sell(session: Session, input: BillInput) {
  const preview = await previewBill(session, input);
  expect(preview.problems, JSON.stringify(preview.problems)).toEqual([]);
  return createInvoice(session, { ...input, idempotencyKey: key(), expectedTotalPaise: preview.totals.totalPaise, expectedRates: preview.expectedRates });
}

const product = (session: Session, sku: string, name: string) => createProduct(session, { name, sku, baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "6000" });

describe("Stock Not Selling", () => {
  it("lists stock that has not sold, with exact days since the last sale, and keeps opening stock's age unknown", async () => {
    const shop = await createTestShop(db, "Intel Shop");
    const owner = (await signInAs(shop.users.owner)).session;
    const { id: supplier } = await createSupplier(owner, { name: "Intel Supplies", phone: "", gstin: "", paymentTermsDays: "30" });
    const { id: soldOut } = await product(owner, "I-1", "Sold then quiet");
    const { id: fresh } = await product(owner, "I-2", "Selling steadily");
    const { id: legacy } = await product(owner, "I-3", "Legacy stock");
    await receiveGoods(owner, { idempotencyKey: key(), supplierId: supplier, supplierBillNo: "I-1", supplierBillDate: today, lines: [{ productId: soldOut, unit: "pc", quantity: "10", cost: "60", gstRateBp: "0" }, { productId: fresh, unit: "pc", quantity: "10", cost: "60", gstRateBp: "0" }] });
    await recordOpeningStock(owner, { idempotencyKey: key(), movementDate: addDays(today, -400), lines: [{ productId: legacy, unit: "pc", quantity: "7" }] });
    await sell(owner, { lines: [{ productId: soldOut, unit: "pc", quantity: "4" }], payments: { cash: "400" } });

    // Everything just happened: nothing is "not selling" yet.
    expect((await stockNotSelling(owner, { days: 60 })).items.map((item) => item.name)).toEqual(["Legacy stock"]);

    // 100 days later, with one product still selling.
    const later = addDays(today, 100);
    const result = await stockNotSelling(owner, { days: 60, asOf: later });
    const byName = Object.fromEntries(result.items.map((item) => [item.name, item]));
    expect(Object.keys(byName).sort()).toEqual(["Legacy stock", "Selling steadily", "Sold then quiet"]);
    expect(byName["Sold then quiet"]).toMatchObject({ status: "not_selling", daysSinceLastSale: 100, onHand: "6", lastSaleDate: today, ageReliable: true });
    // Received 100 days ago, so its stock is in the 91-180 day group: an estimate, with no unknown part.
    expect(byName["Sold then quiet"]!.godowns[0]!.buckets).toMatchObject({ d91_180: "6", unknown: "0" });
    expect(byName["Sold then quiet"]!.unknownAgeQty).toBe("0");
    // Opening stock has no arrival date and is never given one, nor a "last received" date.
    expect(byName["Legacy stock"]).toMatchObject({ status: "never_sold", nonMoving: true, daysSinceLastSale: null, lastReceivedDate: null, unknownAgeQty: "7" });
    expect(byName["Legacy stock"]!.godowns[0]!.buckets.unknown).toBe("7");
    // Its value uses only the cost saved on the opening entry itself (7 x 60), never a later or guessed cost.
    const [opening] = await db.owner.select().from(stockMovements).where(eq(stockMovements.productId, legacy));
    expect(opening!.unitCostPaise).not.toBeNull();
    expect(byName["Legacy stock"]).toMatchObject({ valuePaise: opening!.unitCostPaise! * 7, valuePartial: false });
    expect(byName["Sold then quiet"]).toMatchObject({ valuePaise: 36000, valuePartial: false });
    expect(result.valuePaise).toBe(36000 + 60000 + opening!.unitCostPaise! * 7);
    void fresh;
  });

  it("ranks by days since the last sale, with never-sold first, and never invents a date or a cost", async () => {
    const shop = await createTestShop(db, "Intel Rank");
    const owner = (await signInAs(shop.users.owner)).session;
    const { id: supplier } = await createSupplier(owner, { name: "Rank Supplies", phone: "", gstin: "", paymentTermsDays: "30" });
    const { id: quiet } = await product(owner, "K-1", "Quiet long, small money");
    const { id: recent } = await product(owner, "K-2", "Sold lately, big money");
    const { id: fresh } = await product(owner, "K-3", "Bought, never sold");
    const { id: legacy } = await product(owner, "K-4", "Opening stock, never sold");
    await receiveGoods(owner, { idempotencyKey: key(), supplierId: supplier, supplierBillNo: "K-1", supplierBillDate: today, lines: [{ productId: quiet, unit: "pc", quantity: "10", cost: "60", gstRateBp: "0" }, { productId: recent, unit: "pc", quantity: "10", cost: "600", gstRateBp: "0" }, { productId: fresh, unit: "pc", quantity: "10", cost: "60", gstRateBp: "0" }] });
    await recordOpeningStock(owner, { idempotencyKey: key(), movementDate: addDays(today, -400), lines: [{ productId: legacy, unit: "pc", quantity: "7" }] });
    await sell(owner, { lines: [{ productId: quiet, unit: "pc", quantity: "1" }], payments: { cash: "100" } });
    await sell(owner, { lines: [{ productId: recent, unit: "pc", quantity: "1" }], payments: { cash: "100" } });
    // The second product's last sale is 30 days later than the first one's.
    await withTransaction((tx) => appendStockMovement(tx, { shopId: shop.shopId, productId: recent, movementDate: addDays(today, 30), kind: "sale", qtyBase: BigInt(-1000), unitCostPaise: 60000, sourceType: "invoice", sourceId: randomUUID(), reason: "later sale", createdBy: shop.users.owner.id }));
    const result = await stockNotSelling(owner, { days: 30, asOf: addDays(today, 130) });
    // Never sold first (the one with more money tied up first), then the longest without a sale. Money never overtakes days.
    expect(result.items.map((item) => item.name)).toEqual(["Opening stock, never sold", "Bought, never sold", "Quiet long, small money", "Sold lately, big money"]);
    const byName = Object.fromEntries(result.items.map((item) => [item.name, item]));
    expect(byName["Quiet long, small money"]).toMatchObject({ status: "not_selling", daysSinceLastSale: 130 });
    expect(byName["Sold lately, big money"]).toMatchObject({ status: "not_selling", daysSinceLastSale: 100 });
    expect(byName["Sold lately, big money"]!.valuePaise).toBeGreaterThan(byName["Quiet long, small money"]!.valuePaise!);
    // Opening stock keeps its age unknown: no arrival date, no sale date, and only the cost saved on the opening entry.
    expect(byName["Opening stock, never sold"]).toMatchObject({ status: "never_sold", lastSaleDate: null, daysSinceLastSale: null, lastReceivedDate: null, unknownAgeQty: "7" });
    expect(byName["Bought, never sold"]).toMatchObject({ status: "never_sold", lastSaleDate: null, daysSinceLastSale: null, unknownAgeQty: "0" });
    void fresh; void legacy;
  });

  it("puts a cancelled sale's stock back and does not count the cancelled sale as the last sale", async () => {
    const shop = await createTestShop(db, "Intel Cancel");
    const owner = (await signInAs(shop.users.owner)).session;
    const { id: supplier } = await createSupplier(owner, { name: "Cancel Supplies", phone: "", gstin: "", paymentTermsDays: "30" });
    const { id: item } = await product(owner, "C-1", "Cancelled sale item");
    await receiveGoods(owner, { idempotencyKey: key(), supplierId: supplier, supplierBillNo: "C-1", supplierBillDate: today, lines: [{ productId: item, unit: "pc", quantity: "5", cost: "60", gstRateBp: "0" }] });
    const invoice = await sell(owner, { lines: [{ productId: item, unit: "pc", quantity: "5" }], payments: { cash: "500" } });
    await cancelInvoice(owner, invoice.id, { reason: "Customer changed mind" });
    const result = await stockNotSelling(owner, { days: 60, asOf: addDays(today, 90) });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ status: "never_sold", onHand: "5", lastSaleDate: null, ageReliable: true });
    expect(result.items[0]!.godowns[0]!.buckets.d31_90).toBe("5");
  });

  it("hides costs from anyone who cannot see them, and refuses staff who cannot see stock", async () => {
    const shop = await createTestShop(db, "Intel Roles");
    const owner = (await signInAs(shop.users.owner)).session;
    const manager = (await signInAs(shop.users.manager)).session;
    const cashier = (await signInAs(shop.users.cashier)).session;
    const { id: supplier } = await createSupplier(owner, { name: "Roles Supplies", phone: "", gstin: "", paymentTermsDays: "30" });
    const { id: item } = await product(owner, "R-1", "Roles item");
    await receiveGoods(owner, { idempotencyKey: key(), supplierId: supplier, supplierBillNo: "R-1", supplierBillDate: today, lines: [{ productId: item, unit: "pc", quantity: "5", cost: "60", gstRateBp: "0" }] });
    const asOf = addDays(today, 90);
    const forOwner = await stockNotSelling(owner, { days: 60, asOf });
    expect(forOwner).toMatchObject({ costVisible: true, valuePaise: 30000 });
    const forManager = await stockNotSelling(manager, { days: 60, asOf });
    expect(forManager).toMatchObject({ costVisible: false, valuePaise: null, itemCount: 1 });
    expect(forManager.items[0]!.valuePaise).toBeNull();
    expect(forManager.items[0]!.godowns.every((godown) => godown.valuePaise === null)).toBe(true);
    await expect(stockNotSelling(cashier, { days: 60, asOf })).rejects.toBeTruthy();
  });
});
