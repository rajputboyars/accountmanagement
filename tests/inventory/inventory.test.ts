import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { auditLog } from "@/modules/audit/schema";
import { addProductUnit, createProduct } from "@/modules/catalog";
import { getProductStock, listAdjustments, listStock, rebuildStockCache, recordAdjustment, recordOpeningStock } from "@/modules/inventory";
import { stockAdjustments, stockLevels, stockMovements } from "@/modules/inventory/schema";
import { getDb } from "@/server/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
const isInvalidInput = (error: unknown) => error instanceof ZodError || error instanceof ValidationError;

let shopA: TestShop;
let shopB: TestShop;
const owner = async (shop = shopA) => (await signInAs(shop.users.owner)).session;
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
const today = indiaDate();

beforeAll(async () => {
  shopA = await createTestShop(db, "Shop A");
  shopB = await createTestShop(db, "Shop B");
});

let counter = 0;
/** A piece product sold also by the box of 50, cost ₹22 (like Supreme elbows). */
async function elbow(shop = shopA, costPaise = "22") {
  counter += 1;
  const session = await owner(shop);
  const { id } = await createProduct(session, {
    name: `Elbow ${counter}`,
    sku: `EL-${counter}`,
    baseUnit: "pc",
    hsn: "3917",
    gstRateBp: "1800",
    retailPaise: "38",
    wholesalePaise: "31",
    costPaise,
  });
  await addProductUnit(session, id, { unit: "box", factor: "50" });
  return id;
}

/** A metre product sold also in lengths of 2.75 m. */
async function pipeInMetres() {
  counter += 1;
  const session = await owner();
  const { id } = await createProduct(session, { name: `Pipe m ${counter}`, sku: `PM-${counter}`, baseUnit: "m", hsn: "3917", gstRateBp: "1800", retailPaise: "40", wholesalePaise: "35", costPaise: "30" });
  await addProductUnit(session, id, { unit: "length", factor: "2.75" });
  return id;
}

const open = async (lines: { productId: string; unit: string; quantity: string; unitCost?: string }[], options: { session?: Awaited<ReturnType<typeof owner>>; idempotencyKey?: string; movementDate?: string } = {}) =>
  recordOpeningStock(options.session ?? (await owner()), { idempotencyKey: options.idempotencyKey ?? key(), movementDate: options.movementDate ?? today, lines });

async function cacheMatchesLedger(productId: string) {
  const [ledger] = await db.owner.select({ qty: sql<string>`coalesce(sum(qty_base), 0)::text`, last: sql<number>`max(id)` }).from(stockMovements).where(eq(stockMovements.productId, productId));
  const [cache] = await db.owner.select().from(stockLevels).where(eq(stockLevels.productId, productId));
  expect(cache?.qtyBase).toBe(Number(ledger!.qty).toFixed(3));
  expect(cache?.lastMovementId).toBe(Number(ledger!.last));
}

describe("opening stock", () => {
  it("records one opening movement in base units with cost, and updates the cache", async () => {
    const id = await elbow();
    const result = await open([{ productId: id, unit: "box", quantity: "38.28" }]);
    expect(result.lines).toEqual([expect.objectContaining({ productId: id, qty: "1914", baseUnit: "pc" })]);
    const [movement] = await db.owner.select().from(stockMovements).where(eq(stockMovements.productId, id));
    expect(movement).toMatchObject({ kind: "opening", qtyBase: "1914.000", unitCostPaise: 2200, sourceType: "opening_stock", movementDate: today });
    await cacheMatchesLedger(id);
    const stock = await getProductStock(await owner(), id);
    expect(stock).toMatchObject({ qty: "1914", status: "healthy", hasMovements: true });
    const [audit] = await db.owner.select().from(auditLog).where(and(eq(auditLog.entityId, result.batchId), eq(auditLog.action, "inventory.opening_recorded")));
    expect(audit).toBeDefined();
  });

  it("keeps an entered opening cost and converts decimal units exactly", async () => {
    const id = await pipeInMetres();
    await open([{ productId: id, unit: "length", quantity: "4", unitCost: "29.50" }]);
    const [movement] = await db.owner.select().from(stockMovements).where(eq(stockMovements.productId, id));
    expect(movement).toMatchObject({ qtyBase: "11.000", unitCostPaise: 2950 });
  });

  it("refuses zero, negative and over-precise quantities, fractions of a piece, unknown units and future dates", async () => {
    const id = await elbow();
    for (const quantity of ["0", "-5", "1.2345", "abc"]) {
      await expect(open([{ productId: id, unit: "pc", quantity }]), quantity).rejects.toSatisfy(isInvalidInput);
    }
    await expect(open([{ productId: id, unit: "pc", quantity: "2.5" }])).rejects.toMatchObject({ details: { fieldErrors: { "lines.0.quantity": expect.stringMatching(/whole number/) } } });
    await expect(open([{ productId: id, unit: "box", quantity: "0.01" }])).rejects.toMatchObject({ details: { fieldErrors: { "lines.0.quantity": expect.stringMatching(/whole number/) } } });
    await expect(open([{ productId: id, unit: "kg", quantity: "1" }])).rejects.toMatchObject({ details: { fieldErrors: { "lines.0.unit": expect.any(String) } } });
    await expect(open([{ productId: id, unit: "pc", quantity: "1" }], { movementDate: "2999-01-01" })).rejects.toSatisfy(isInvalidInput);
    expect((await getProductStock(await owner(), id)).status).toBe("uncounted");
  });

  it("refuses a second opening for the same product and the same product twice in one submission", async () => {
    const id = await elbow();
    await open([{ productId: id, unit: "pc", quantity: "10" }]);
    await expect(open([{ productId: id, unit: "pc", quantity: "20" }])).rejects.toMatchObject({ details: { fieldErrors: { "lines.0.productId": expect.stringMatching(/adjustment/) } } });
    const other = await elbow();
    await expect(
      open([
        { productId: other, unit: "pc", quantity: "1" },
        { productId: other, unit: "pc", quantity: "2" },
      ]),
    ).rejects.toSatisfy(isInvalidInput);
    expect((await getProductStock(await owner(), id)).qty).toBe("10");
  });

  it("saves all lines or none", async () => {
    const good = await elbow();
    const bad = await elbow();
    await open([{ productId: bad, unit: "pc", quantity: "1" }]);
    await expect(
      open([
        { productId: good, unit: "pc", quantity: "100" },
        { productId: bad, unit: "pc", quantity: "5" },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await db.owner.select().from(stockMovements).where(eq(stockMovements.productId, good))).toHaveLength(0);
    expect(await db.owner.select().from(stockLevels).where(eq(stockLevels.productId, good))).toHaveLength(0);
  });

  it("returns the first result when the same submission is repeated, and refuses a reused key with different lines", async () => {
    const id = await elbow();
    const idempotencyKey = key();
    const first = await open([{ productId: id, unit: "pc", quantity: "7" }], { idempotencyKey });
    const again = await open([{ productId: id, unit: "pc", quantity: "7" }], { idempotencyKey });
    expect(again).toMatchObject({ batchId: first.batchId, replayed: true });
    expect(await db.owner.select().from(stockMovements).where(eq(stockMovements.productId, id))).toHaveLength(1);
    await expect(open([{ productId: id, unit: "pc", quantity: "8" }], { idempotencyKey })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("lets only one of two simultaneous openings for the same product through", async () => {
    const id = await elbow();
    const results = await Promise.allSettled([open([{ productId: id, unit: "pc", quantity: "10" }]), open([{ productId: id, unit: "pc", quantity: "11" }])]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await db.owner.select().from(stockMovements).where(eq(stockMovements.productId, id))).toHaveLength(1);
    await cacheMatchesLedger(id);
  });
});

describe("stock adjustments (spec S3)", () => {
  it("needs a reason, records damage with a number, and refuses going below zero", async () => {
    const id = await elbow();
    await open([{ productId: id, unit: "pc", quantity: "2" }]);
    const { session } = await signInAs(shopA.users.inventory);
    await expect(recordAdjustment(session, { idempotencyKey: key(), productId: id, kind: "damage", unit: "pc", quantity: "1", reason: "" })).rejects.toSatisfy(isInvalidInput);
    const result = await recordAdjustment(session, { idempotencyKey: key(), productId: id, kind: "damage", unit: "pc", quantity: "1", reason: "Cracked in the store" });
    expect(result).toMatchObject({ qtyChange: "-1", newQty: "1" });
    expect(result.number).toMatch(/^ADJ\/\d{2}-\d{2}\/00001$/);
    await expect(recordAdjustment(session, { idempotencyKey: key(), productId: id, kind: "damage", unit: "pc", quantity: "10", reason: "Broken" })).rejects.toMatchObject({ code: "NEGATIVE_STOCK" });
    await cacheMatchesLedger(id);
    const [audit] = await db.owner.select().from(auditLog).where(and(eq(auditLog.entityId, result.id), eq(auditLog.action, "inventory.adjustment_recorded")));
    expect(audit).toMatchObject({ reason: "Cracked in the store", userId: shopA.users.inventory.id });
    expect((await listAdjustments(session)).find((row) => row.id === result.id)).toMatchObject({ kindLabel: "Damaged", qtyChange: "-1", productId: id });
  });

  it("handles returns and count fixes in both directions, and reaches 'out of stock' at zero", async () => {
    const id = await elbow();
    await open([{ productId: id, unit: "pc", quantity: "100" }]);
    const session = await owner();
    await recordAdjustment(session, { idempotencyKey: key(), productId: id, kind: "return_in", unit: "pc", quantity: "4", reason: "Customer returned unused" });
    await recordAdjustment(session, { idempotencyKey: key(), productId: id, kind: "count", direction: "out", unit: "box", quantity: "2", reason: "Count found fewer" });
    expect((await getProductStock(session, id)).qty).toBe("4");
    await expect(recordAdjustment(session, { idempotencyKey: key(), productId: id, kind: "count", unit: "pc", quantity: "1", reason: "Recount" })).rejects.toSatisfy(isInvalidInput);
    await recordAdjustment(session, { idempotencyKey: key(), productId: id, kind: "count", direction: "out", unit: "pc", quantity: "4", reason: "None left" });
    expect((await getProductStock(session, id)).status).toBe("out");
    await cacheMatchesLedger(id);
  });

  it("needs opening stock first", async () => {
    const id = await elbow();
    await expect(recordAdjustment(await owner(), { idempotencyKey: key(), productId: id, kind: "return_in", unit: "pc", quantity: "1", reason: "Return" })).rejects.toMatchObject({ code: "NO_OPENING_STOCK" });
  });

  it("sends adjustments over ₹2,000 at cost, or of uncosted products, to the owner", async () => {
    const id = await elbow();
    await open([{ productId: id, unit: "pc", quantity: "500" }]);
    const { session: manager } = await signInAs(shopA.users.manager);
    // 90 × ₹22 = ₹1,980: allowed. 91 × ₹22 = ₹2,002: needs the owner.
    await recordAdjustment(manager, { idempotencyKey: key(), productId: id, kind: "damage", unit: "pc", quantity: "90", reason: "Water damage" });
    await expect(recordAdjustment(manager, { idempotencyKey: key(), productId: id, kind: "damage", unit: "pc", quantity: "91", reason: "Water damage" })).rejects.toMatchObject({ code: "OWNER_APPROVAL_REQUIRED" });
    await recordAdjustment(await owner(), { idempotencyKey: key(), productId: id, kind: "damage", unit: "pc", quantity: "91", reason: "Water damage" });
    const uncosted = await elbow(shopA, "");
    await open([{ productId: uncosted, unit: "pc", quantity: "5" }]);
    await expect(recordAdjustment(manager, { idempotencyKey: key(), productId: uncosted, kind: "damage", unit: "pc", quantity: "1", reason: "Broken" })).rejects.toMatchObject({ code: "OWNER_APPROVAL_REQUIRED" });
  });

  it("serialises simultaneous adjustments so stock never goes below zero", async () => {
    const id = await elbow();
    await open([{ productId: id, unit: "pc", quantity: "5" }]);
    const session = await owner();
    const damage = () => recordAdjustment(session, { idempotencyKey: key(), productId: id, kind: "damage", unit: "pc", quantity: "3", reason: "Broken" });
    const results = await Promise.allSettled([damage(), damage(), damage()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await getProductStock(session, id)).qty).toBe("2");
    await cacheMatchesLedger(id);
    // Numbers stay gap-free: failed attempts gave theirs back.
    const numbers = (await db.owner.select({ number: stockAdjustments.number }).from(stockAdjustments).where(eq(stockAdjustments.shopId, shopA.shopId))).map((row) => row.number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("replays a repeated adjustment instead of applying it twice", async () => {
    const id = await elbow();
    await open([{ productId: id, unit: "pc", quantity: "10" }]);
    const session = await owner();
    const input = { idempotencyKey: key(), productId: id, kind: "damage", unit: "pc", quantity: "1", reason: "Broken" };
    const first = await recordAdjustment(session, input);
    const again = await recordAdjustment(session, input);
    expect(again).toMatchObject({ id: first.id, replayed: true });
    expect((await getProductStock(session, id)).qty).toBe("9");
  });
});

describe("ledger integrity", () => {
  it("keeps the journal append-only for the app", async () => {
    const id = await elbow();
    await open([{ productId: id, unit: "pc", quantity: "3" }]);
    await expect(getDb().execute(sql`update stock_movements set qty_base = 999 where product_id = ${id}`)).rejects.toThrow();
    await expect(getDb().execute(sql`delete from stock_movements where product_id = ${id}`)).rejects.toThrow();
    expect((await getProductStock(await owner(), id)).qty).toBe("3");
  });

  it("flags a cache that disagrees with the journal, and rebuilds it from the journal", async () => {
    const id = await elbow();
    await open([{ productId: id, unit: "pc", quantity: "30" }]);
    await db.owner.update(stockLevels).set({ qtyBase: "999.000" }).where(eq(stockLevels.productId, id));
    const stock = await getProductStock(await owner(), id);
    expect(stock).toMatchObject({ status: "needs_check", qty: "30" });
    await rebuildStockCache(await owner(), id);
    expect((await getProductStock(await owner(), id)).status).toBe("healthy");
    await cacheMatchesLedger(id);
  });

  it("tells uncounted products apart from out-of-stock ones in the list", async () => {
    const uncounted = await elbow();
    const list = await listStock(await owner(), { q: `Elbow ${counter}` });
    expect(list.items.find((row) => row.productId === uncounted)).toMatchObject({ status: "uncounted", qty: null });
    expect((await listStock(await owner(), { status: "uncounted" })).items.every((row) => row.status === "uncounted")).toBe(true);
  });
});

describe("permissions and isolation", () => {
  it("lets only the owner enter opening stock and keeps cashiers out of stock screens", async () => {
    const id = await elbow();
    for (const role of ["manager", "inventory", "cashier"] as const) {
      const { session } = await signInAs(shopA.users[role]);
      await expect(open([{ productId: id, unit: "pc", quantity: "1" }], { session })).rejects.toBeInstanceOf(ForbiddenError);
    }
    const { session: cashier } = await signInAs(shopA.users.cashier);
    await expect(listStock(cashier)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getProductStock(cashier, id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordAdjustment(cashier, { idempotencyKey: key(), productId: id, kind: "damage", unit: "pc", quantity: "1", reason: "Broken" })).rejects.toBeInstanceOf(ForbiddenError);
    const { session: inventory } = await signInAs(shopA.users.inventory);
    await expect(rebuildStockCache(cashier, id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listStock(inventory)).resolves.toHaveProperty("items");
  });

  it("never reads or writes another shop's products", async () => {
    const theirs = await elbow(shopB);
    await open([{ productId: theirs, unit: "pc", quantity: "50" }], { session: await owner(shopB) });
    const session = await owner();
    await expect(open([{ productId: theirs, unit: "pc", quantity: "5" }])).rejects.toMatchObject({ details: { fieldErrors: { "lines.0.productId": "Product not found." } } });
    await expect(getProductStock(session, theirs)).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordAdjustment(session, { idempotencyKey: key(), productId: theirs, kind: "damage", unit: "pc", quantity: "1", reason: "Broken" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(rebuildStockCache(session, theirs)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listStock(session)).items.some((row) => row.productId === theirs)).toBe(false);
    expect((await getProductStock(await owner(shopB), theirs)).qty).toBe("50");
  });
});
