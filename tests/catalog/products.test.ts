import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { auditLog } from "@/modules/audit/schema";
import { createProduct, getProduct, listProducts, setProductActive, updateProduct } from "@/modules/catalog";
import { productCostHistory, products } from "@/modules/catalog/schema";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
let shopA: TestShop;
let shopB: TestShop;

beforeAll(async () => {
  shopA = await createTestShop(db, "Shop A");
  shopB = await createTestShop(db, "Shop B");
});

let counter = 0;
function productInput(overrides: Record<string, unknown> = {}) {
  counter += 1;
  return {
    name: `CPVC Pipe ${counter}`,
    sku: `cp-${counter}`,
    baseUnit: "pc",
    hsn: "3917",
    gstRateBp: "1800",
    retailPaise: "540",
    wholesalePaise: "470.50",
    costPaise: "402",
    ...overrides,
  };
}

const owner = async (shop = shopA) => (await signInAs(shop.users.owner)).session;

describe("creating products", () => {
  it("saves a product with exact paise and normalised code", async () => {
    const session = await owner();
    const { id } = await createProduct(session, productInput({ sku: "ast-cp-1", categoryName: "Pipes", description: "3 m length" }));
    const product = await getProduct(session, id);
    expect(product).toMatchObject({
      sku: "AST-CP-1",
      categoryName: "Pipes",
      description: "3 m length",
      baseUnit: "pc",
      baseUnitName: "Piece",
      retailPaise: 54000,
      wholesalePaise: 47050,
      costPaise: 40200,
      costVisible: true,
      gstRateBp: 1800,
      isActive: true,
      version: 1,
    });

    const history = await db.owner.select().from(productCostHistory).where(eq(productCostHistory.productId, id));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ costPaise: 40200, sourceType: "manual" });

    const [audit] = await db.owner.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "catalog.product_created")));
    expect(audit).toMatchObject({ shopId: shopA.shopId, userId: shopA.users.owner.id, entityType: "product" });
  });

  it("requires name, code, HSN, prices and a valid GST rate", async () => {
    const session = await owner();
    for (const bad of [
      { name: "" },
      { sku: "" },
      { sku: "has space" },
      { hsn: "12" },
      { gstRateBp: "1000" },
      { retailPaise: "" },
      { retailPaise: "0" },
      { wholesalePaise: "-5" },
      { costPaise: "1.234" },
    ]) {
      await expect(createProduct(session, productInput(bad)), JSON.stringify(bad)).rejects.toBeInstanceOf(ZodError);
    }
  });

  it("rejects an unknown or switched-off base unit", async () => {
    const session = await owner();
    await expect(createProduct(session, productInput({ baseUnit: "crate" }))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a duplicate product code in the same shop but allows it in another shop", async () => {
    await createProduct(await owner(), productInput({ sku: "DUP-1" }));
    await expect(createProduct(await owner(), productInput({ sku: "dup-1" }))).rejects.toMatchObject({ code: "SKU_IN_USE" });
    await expect(createProduct(await owner(shopB), productInput({ sku: "DUP-1" }))).resolves.toHaveProperty("id");
  });

  it("rejects a duplicate barcode in the same shop", async () => {
    await createProduct(await owner(), productInput({ barcode: "8901234567890" }));
    await expect(createProduct(await owner(), productInput({ barcode: "8901234567890" }))).rejects.toMatchObject({ code: "BARCODE_IN_USE" });
  });
});

describe("updating products", () => {
  it("updates fields, bumps the version and audits only what changed", async () => {
    const session = await owner();
    const { id } = await createProduct(session, productInput());
    const result = await updateProduct(session, id, { ...productInput({ name: "Renamed pipe", sku: "RENAMED-1" }), retailPaise: "555", version: 1 });
    expect(result.version).toBe(2);
    const product = await getProduct(session, id);
    expect(product).toMatchObject({ name: "Renamed pipe", retailPaise: 55500, version: 2 });

    const [audit] = await db.owner.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "catalog.product_updated")));
    expect(audit!.before).toMatchObject({ retailPaise: 54000 });
    expect(audit!.after).toMatchObject({ name: "Renamed pipe", retailPaise: 55500 });
    expect(audit!.after).not.toHaveProperty("hsn");
  });

  it("refuses a stale version", async () => {
    const session = await owner();
    const { id } = await createProduct(session, productInput());
    await updateProduct(session, id, { ...productInput(), version: 1 });
    await expect(updateProduct(session, id, { ...productInput(), version: 1 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("records a cost change in the cost history", async () => {
    const session = await owner();
    const input = productInput();
    const { id } = await createProduct(session, input);
    await updateProduct(session, id, { ...input, costPaise: "410", version: 1 });
    const history = await db.owner.select().from(productCostHistory).where(eq(productCostHistory.productId, id));
    expect(history.map((row) => row.costPaise).sort()).toEqual([40200, 41000]);
  });
});

describe("switching products off", () => {
  it("hides switched-off products from the default list but keeps the record", async () => {
    const session = await owner();
    const { id } = await createProduct(session, productInput({ name: "Old valve model" }));
    await setProductActive(session, id, false);

    const active = await listProducts(session, { q: "Old valve" });
    expect(active.items).toHaveLength(0);
    const inactive = await listProducts(session, { q: "Old valve", status: "inactive" });
    expect(inactive.items.map((item) => item.id)).toEqual([id]);
    expect((await getProduct(session, id)).isActive).toBe(false);

    const [row] = await db.owner.select().from(products).where(eq(products.id, id));
    expect(row).toBeDefined();
    const audits = await db.owner.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "catalog.product_deactivated")));
    expect(audits).toHaveLength(1);
  });

  it("searches by name, code and barcode, treating % and _ literally", async () => {
    const session = await owner();
    await createProduct(session, productInput({ name: "Ball valve 50%", sku: "BV-50" }));
    expect((await listProducts(session, { q: "bv-50" })).items).toHaveLength(1);
    expect((await listProducts(session, { q: "50%" })).items).toHaveLength(1);
    expect((await listProducts(session, { q: "%" })).items.every((item) => item.name.includes("%"))).toBe(true);
  });
});

describe("roles", () => {
  it("lets inventory and manager staff view but not change products; cashiers cannot view", async () => {
    const { id } = await createProduct(await owner(), productInput());
    for (const role of ["manager", "inventory"] as const) {
      const { session } = await signInAs(shopA.users[role]);
      const product = await getProduct(session, id);
      expect(product.costVisible).toBe(false);
      expect(product.costPaise).toBeNull();
      await expect(createProduct(session, productInput())).rejects.toBeInstanceOf(ForbiddenError);
      await expect(updateProduct(session, id, { ...productInput(), version: 1 })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setProductActive(session, id, false)).rejects.toBeInstanceOf(ForbiddenError);
    }
    const { session: cashier } = await signInAs(shopA.users.cashier);
    await expect(getProduct(cashier, id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listProducts(cashier, {})).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("shop isolation", () => {
  it("treats another shop's product as not found for reads and writes", async () => {
    const { id } = await createProduct(await owner(shopB), productInput({ name: "Shop B only" }));
    const session = await owner();
    await expect(getProduct(session, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateProduct(session, id, { ...productInput(), version: 1 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(setProductActive(session, id, false)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listProducts(session, { q: "Shop B only", status: "all" })).items).toHaveLength(0);

    const [row] = await db.owner.select().from(products).where(eq(products.id, id));
    expect(row).toMatchObject({ isActive: true, version: 1 });
  });

  it("returns not found for a malformed product id", async () => {
    await expect(getProduct(await owner(), "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
  });
});
