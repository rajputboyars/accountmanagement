import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { auditLog } from "@/modules/audit/schema";
import {
  addProductUnit,
  createProduct,
  createUnit,
  getProduct,
  listUnits,
  setProductUnitActive,
  setUnitActive,
  updateProduct,
  updateProductUnitFactor,
} from "@/modules/catalog";
import { productUnits } from "@/modules/catalog/schema";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
/** Bad input is refused either by the Zod schema or by a business-rule ValidationError. */
const isInvalidInput = (error: unknown) => error instanceof ZodError || error instanceof ValidationError;
let shopA: TestShop;
let shopB: TestShop;

beforeAll(async () => {
  shopA = await createTestShop(db, "Shop A");
  shopB = await createTestShop(db, "Shop B");
});

const owner = async (shop = shopA) => (await signInAs(shop.users.owner)).session;

let counter = 0;
async function newProduct(baseUnit = "pc", shop = shopA) {
  counter += 1;
  const input = { name: `Item ${counter}`, sku: `IT-${counter}`, baseUnit, hsn: "3917", gstRateBp: "1800", retailPaise: "10", wholesalePaise: "9" };
  const { id } = await createProduct(await owner(shop), input);
  return { id, input };
}

describe("units", () => {
  it("gives every shop the default units", async () => {
    const codes = (await listUnits(await owner())).map((unit) => unit.code);
    expect(codes).toEqual(expect.arrayContaining(["pc", "box", "bundle", "m", "length"]));
  });

  it("counts only this shop's products for each unit", async () => {
    const countFor = async (shop: TestShop, code: string) => (await listUnits(await owner(shop))).find((unit) => unit.code === code)!.productCount;
    const beforeA = await countFor(shopA, "set");
    const beforeB = await countFor(shopB, "set");
    await newProduct("set");
    await newProduct("set");
    await newProduct("set", shopB);
    expect(await countFor(shopA, "set")).toBe(beforeA + 2);
    expect(await countFor(shopB, "set")).toBe(beforeB + 1);
  });

  it("adds a unit, rejecting duplicate names and short names", async () => {
    const session = await owner();
    const unit = await createUnit(session, { name: "Coil", code: "coil" });
    expect(unit).toMatchObject({ code: "coil", allowDecimal: false, isActive: true });
    await expect(createUnit(session, { name: "coil", code: "coil2" })).rejects.toMatchObject({ code: "UNIT_NAME_IN_USE" });
    await expect(createUnit(session, { name: "Coil roll", code: "coil" })).rejects.toMatchObject({ code: "UNIT_CODE_IN_USE" });
    await expect(createUnit(session, { name: "Bad", code: "Has Space" })).rejects.toSatisfy(isInvalidInput);
    // Units are per shop: another shop may use the same short name.
    await expect(createUnit(await owner(shopB), { name: "Coil", code: "coil" })).resolves.toHaveProperty("code", "coil");
  });

  it("hides switched-off units from new products and audits the change", async () => {
    const session = await owner();
    await createUnit(session, { name: "Crate", code: "crate" });
    await setUnitActive(session, "crate", false);
    expect((await listUnits(session)).map((unit) => unit.code)).not.toContain("crate");
    expect((await listUnits(session, { includeInactive: true })).map((unit) => unit.code)).toContain("crate");
    await expect(newProduct("crate")).rejects.toMatchObject({ code: "UNIT_INACTIVE" });
    const audits = await db.owner.select().from(auditLog).where(and(eq(auditLog.shopId, shopA.shopId), eq(auditLog.action, "catalog.unit_deactivated")));
    expect(audits).toHaveLength(1);
  });

  it("only lets the owner manage units", async () => {
    const { session } = await signInAs(shopA.users.manager);
    await expect(listUnits(session)).resolves.not.toHaveLength(0);
    await expect(createUnit(session, { name: "Tin", code: "tin" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setUnitActive(session, "box", false)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("product pack sizes", () => {
  it("stores a per-product conversion exactly (1 Box = 50 pc)", async () => {
    const { id } = await newProduct();
    await addProductUnit(await owner(), id, { unit: "box", factor: "50" });
    const product = await getProduct(await owner(), id);
    expect(product.conversions).toEqual([expect.objectContaining({ unit: "box", unitName: "Box", factor: "50", isActive: true })]);
    const [row] = await db.owner.select().from(productUnits).where(eq(productUnits.productId, id));
    expect(row!.factor).toBe("50.000");
  });

  it("lets two products use different sizes for the same pack unit", async () => {
    const a = await newProduct();
    const b = await newProduct();
    await addProductUnit(await owner(), a.id, { unit: "box", factor: "50" });
    await addProductUnit(await owner(), b.id, { unit: "box", factor: "25" });
    expect((await getProduct(await owner(), a.id)).conversions[0]!.factor).toBe("50");
    expect((await getProduct(await owner(), b.id)).conversions[0]!.factor).toBe("25");
  });

  it("accepts up to three decimals when the base unit can be split", async () => {
    const { id } = await newProduct("m");
    await addProductUnit(await owner(), id, { unit: "length", factor: "2.75" });
    await addProductUnit(await owner(), id, { unit: "bundle", factor: "0.001" });
    const factors = (await getProduct(await owner(), id)).conversions.map((conversion) => conversion.factor).sort();
    expect(factors).toEqual(["0.001", "2.75"]);
  });

  it("rejects zero, negative, one, malformed and over-precise sizes", async () => {
    const { id } = await newProduct("m");
    for (const factor of ["0", "0.000", "-5", "1", "1.000", "abc", "2.5.1", "1e3", "2.3456", ""]) {
      await expect(addProductUnit(await owner(), id, { unit: "box", factor }), factor).rejects.toSatisfy(isInvalidInput);
    }
    expect((await getProduct(await owner(), id)).conversions).toHaveLength(0);
  });

  it("requires whole-number sizes when the base unit can't be split", async () => {
    const { id } = await newProduct("pc");
    await expect(addProductUnit(await owner(), id, { unit: "box", factor: "2.5" })).rejects.toSatisfy(isInvalidInput);
  });

  it("rejects the base unit itself, duplicates, and unknown or switched-off units", async () => {
    const session = await owner();
    const { id } = await newProduct();
    await expect(addProductUnit(session, id, { unit: "pc", factor: "10" })).rejects.toSatisfy(isInvalidInput);
    await addProductUnit(session, id, { unit: "box", factor: "10" });
    await expect(addProductUnit(session, id, { unit: "box", factor: "20" })).rejects.toMatchObject({ code: "PACKAGING_EXISTS" });
    await expect(addProductUnit(session, id, { unit: "nosuch", factor: "10" })).rejects.toBeInstanceOf(NotFoundError);
    await createUnit(session, { name: "Sack", code: "sack" });
    await setUnitActive(session, "sack", false);
    await expect(addProductUnit(session, id, { unit: "sack", factor: "10" })).rejects.toMatchObject({ code: "UNIT_INACTIVE" });
  });

  it("changes a size, retires and reuses a pack unit, with audit rows", async () => {
    const session = await owner();
    const { id } = await newProduct();
    const { id: packId } = await addProductUnit(session, id, { unit: "bundle", factor: "10" });
    await updateProductUnitFactor(session, id, packId, "12");
    await setProductUnitActive(session, id, packId, false);
    let product = await getProduct(session, id);
    expect(product.conversions[0]).toMatchObject({ factor: "12", isActive: false });

    // Adding the retired unit again brings back the same row with the new size.
    const { id: again } = await addProductUnit(session, id, { unit: "bundle", factor: "15" });
    expect(again).toBe(packId);
    product = await getProduct(session, id);
    expect(product.conversions[0]).toMatchObject({ factor: "15", isActive: true });

    const actions = (await db.owner.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, id))).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["catalog.packaging_added", "catalog.packaging_changed", "catalog.packaging_retired", "catalog.packaging_reactivated"]));
  });

  it("locks the base unit once pack sizes exist", async () => {
    const session = await owner();
    const { id, input } = await newProduct();
    await addProductUnit(session, id, { unit: "box", factor: "10" });
    await expect(updateProduct(session, id, { ...input, baseUnit: "m", version: 1 })).rejects.toMatchObject({ code: "BASE_UNIT_LOCKED" });
  });

  it("only lets the owner change pack sizes", async () => {
    const { id } = await newProduct();
    const { id: packId } = await addProductUnit(await owner(), id, { unit: "box", factor: "10" });
    const { session } = await signInAs(shopA.users.inventory);
    await expect(addProductUnit(session, id, { unit: "bundle", factor: "5" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateProductUnitFactor(session, id, packId, "20")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setProductUnitActive(session, id, packId, false)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("cannot touch another shop's product or pack sizes", async () => {
    const other = await newProduct("pc", shopB);
    const { id: packId } = await addProductUnit(await owner(shopB), other.id, { unit: "box", factor: "10" });
    const session = await owner();
    await expect(addProductUnit(session, other.id, { unit: "bundle", factor: "5" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateProductUnitFactor(session, other.id, packId, "99")).rejects.toBeInstanceOf(NotFoundError);
    await expect(setProductUnitActive(session, other.id, packId, false)).rejects.toBeInstanceOf(NotFoundError);

    // A pack id from shop B paired with a shop A product is also not found.
    const mine = await newProduct();
    await expect(updateProductUnitFactor(session, mine.id, packId, "99")).rejects.toBeInstanceOf(NotFoundError);

    const [row] = await db.owner.select().from(productUnits).where(eq(productUnits.id, packId));
    expect(row).toMatchObject({ factor: "10.000", isActive: true });
  });
});
