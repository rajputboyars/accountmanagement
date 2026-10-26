import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { auditLog } from "@/modules/audit/schema";
import { addProductUnit, createProduct, setProductActive } from "@/modules/catalog";
import { customers } from "@/modules/parties/schema";
import {
  addCustomerRule,
  addSlab,
  listRulesForProduct,
  listSlabs,
  quoteForSession,
  setCustomerRuleActive,
  setSlabActive,
  updateCustomerRule,
  updateSlabPrice,
} from "@/modules/pricing";
import { customerPriceRules, priceSlabs } from "@/modules/pricing/schema";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
const isInvalidInput = (error: unknown) => error instanceof ZodError || error instanceof ValidationError;

let shopA: TestShop;
let shopB: TestShop;
const owner = async (shop = shopA) => (await signInAs(shop.users.owner)).session;

async function addCustomer(shop: TestShop, type: "walkin" | "retail" | "wholesale", name = `${type} customer`) {
  const id = randomUUID();
  await db.owner.insert(customers).values({ id, shopId: shop.shopId, name, type });
  return id;
}

let counter = 0;
/** Astral-like pipe: retail ₹540, wholesale ₹470, cost ₹402, with slabs 50+ ₹455 and 100+ ₹440 and a bundle of 10. */
async function pipe(shop = shopA) {
  counter += 1;
  const session = await owner(shop);
  const { id } = await createProduct(session, {
    name: `CPVC Pipe ${counter}`,
    sku: `PIPE-${counter}`,
    baseUnit: "pc",
    hsn: "3917",
    gstRateBp: "1800",
    retailPaise: "540",
    wholesalePaise: "470",
    costPaise: "402",
  });
  await addProductUnit(session, id, { unit: "bundle", factor: "10" });
  await addProductUnit(session, id, { unit: "box", factor: "50" });
  const s50 = await addSlab(session, id, { minQty: "50", price: "455" });
  const s100 = await addSlab(session, id, { minQty: "100", price: "440" });
  return { id, s50: s50.id, s100: s100.id };
}

let wholesaler: string;
let retailer: string;

beforeAll(async () => {
  shopA = await createTestShop(db, "Shop A");
  shopB = await createTestShop(db, "Shop B");
  wholesaler = await addCustomer(shopA, "wholesale", "Mehta Constructions");
  retailer = await addCustomer(shopA, "retail", "Ravi");
});

const quote = async (input: Record<string, unknown>, session?: Awaited<ReturnType<typeof owner>>) => quoteForSession(session ?? (await owner()), input);

describe("quotes (spec P1, P3)", () => {
  it("prices with no customer on the retail list", async () => {
    const { id } = await pipe();
    const result = await quote({ productId: id, unit: "pc", quantity: "150" });
    expect(result).toMatchObject({ priceList: "retail", baseRatePaise: 54000, lineAmountPaise: 8100000, badge: "Retail" });
  });

  it("uses the wholesale list for a wholesale customer, with slab boundaries", async () => {
    const { id } = await pipe();
    const at = async (quantity: string) => (await quote({ productId: id, unit: "pc", quantity, customerId: wholesaler })).baseRatePaise;
    expect(await at("49")).toBe(47000);
    expect(await at("50")).toBe(45500);
    expect(await at("99")).toBe(45500);
    expect(await at("100")).toBe(44000);
    expect(await at("101")).toBe(44000);
  });

  it("keeps a retail customer on the retail list even at 150 pieces, unless wholesale is chosen by hand", async () => {
    const { id } = await pipe();
    expect((await quote({ productId: id, unit: "pc", quantity: "150", customerId: retailer })).baseRatePaise).toBe(54000);
    expect((await quote({ productId: id, unit: "pc", quantity: "150", customerId: retailer, priceList: "wholesale" })).baseRatePaise).toBe(44000);
  });

  it("P1: a customer's fixed ₹430 at 100+ beats the ₹440 slab", async () => {
    const { id } = await pipe();
    await addCustomerRule(await owner(), { kind: "fixed", customerId: wholesaler, productId: id, price: "430", minQty: "100" });
    const result = await quote({ productId: id, unit: "pc", quantity: "150", customerId: wholesaler });
    expect(result).toMatchObject({ baseRatePaise: 43000, lineAmountPaise: 6450000, badge: "Special ₹430" });
    expect(result.explanation.join(" ")).toMatch(/lower, so it is used/);
  });

  it("P3: 3 boxes of 50 reach the 100+ slab; same line as 150 pieces", async () => {
    const { id } = await pipe();
    const boxes = await quote({ productId: id, unit: "box", quantity: "3", customerId: wholesaler });
    const pieces = await quote({ productId: id, unit: "pc", quantity: "150", customerId: wholesaler });
    expect(boxes).toMatchObject({ baseQuantity: "150", baseRatePaise: 44000, saleUnitRatePaise: 2200000, lineAmountPaise: 6600000 });
    expect(pieces.lineAmountPaise).toBe(boxes.lineAmountPaise);
    // 9 bundles of 10 = 90 pc: only the 50+ slab.
    expect((await quote({ productId: id, unit: "bundle", quantity: "9", customerId: wholesaler })).baseRatePaise).toBe(45500);
  });

  it("prefers a product % over an all-products %", async () => {
    const { id } = await pipe();
    const customer = await addCustomer(shopA, "wholesale", "Gupta Builders");
    await addCustomerRule(await owner(), { kind: "pct", customerId: customer, productId: "", percent: "1" });
    expect((await quote({ productId: id, unit: "pc", quantity: "30", customerId: customer })).baseRatePaise).toBe(46530);
    await addCustomerRule(await owner(), { kind: "pct", customerId: customer, productId: id, percent: "2" });
    const result = await quote({ productId: id, unit: "pc", quantity: "30", customerId: customer });
    expect(result.baseRatePaise).toBe(46060);
    expect(result.badge).toBe("−2%");
  });

  it("refuses units the product isn't sold in, zero, negative and over-precise quantities", async () => {
    const { id } = await pipe();
    await expect(quote({ productId: id, unit: "kg", quantity: "1" })).rejects.toBeInstanceOf(ValidationError);
    for (const quantity of ["0", "-1", "abc", "1.2345"]) {
      await expect(quote({ productId: id, unit: "pc", quantity }), quantity).rejects.toSatisfy(isInvalidInput);
    }
    await expect(quote({ productId: id, unit: "pc", quantity: "2.5" })).rejects.toThrow(/can't be split/);
  });

  it("refuses switched-off products and ignores retired pack sizes, slabs and rules", async () => {
    const { id, s100 } = await pipe();
    const session = await owner();
    const { id: ruleId } = await addCustomerRule(session, { kind: "fixed", customerId: wholesaler, productId: id, price: "420", minQty: "0" });
    await setSlabActive(session, id, s100, false);
    await setCustomerRuleActive(session, ruleId, false);
    const result = await quote({ productId: id, unit: "pc", quantity: "150", customerId: wholesaler });
    expect(result.baseRatePaise).toBe(45500);
    await setProductActive(session, id, false);
    await expect(quote({ productId: id, unit: "pc", quantity: "1" })).rejects.toMatchObject({ code: "PRODUCT_INACTIVE" });
  });

  it("writes nothing", async () => {
    const { id } = await pipe();
    const before = await db.owner.select().from(auditLog).where(eq(auditLog.shopId, shopA.shopId));
    await quote({ productId: id, unit: "pc", quantity: "10", customerId: wholesaler });
    const after = await db.owner.select().from(auditLog).where(eq(auditLog.shopId, shopA.shopId));
    expect(after).toHaveLength(before.length);
  });
});

describe("slab rules (spec P2)", () => {
  it("refuses a slab above wholesale, at or below 1, and below cost unless confirmed", async () => {
    const { id } = await pipe();
    const session = await owner();
    await expect(addSlab(session, id, { minQty: "200", price: "480" })).rejects.toThrow(/above the wholesale price/);
    await expect(addSlab(session, id, { minQty: "1", price: "400" })).rejects.toThrow(/more than 1/);
    await expect(addSlab(session, id, { minQty: "200.5", price: "430" })).rejects.toThrow(/whole number/);
    await expect(addSlab(session, id, { minQty: "200", price: "390" })).rejects.toMatchObject({ code: "BELOW_COST" });
    const { id: slabId } = await addSlab(session, id, { minQty: "200", price: "390", confirmBelowCost: "on" });
    const [audit] = await db.owner.select().from(auditLog).where(and(eq(auditLog.entityId, slabId), eq(auditLog.action, "pricing.slab_added")));
    expect(audit!.after).toMatchObject({ belowCostConfirmed: true, pricePaise: 39000 });
    expect((await listSlabs(session, id)).find((slab) => slab.id === slabId)?.belowCost).toBe(true);
  });

  it("allows one active slab per minimum, and changes or retires slabs with audit rows", async () => {
    const { id, s50 } = await pipe();
    const session = await owner();
    await expect(addSlab(session, id, { minQty: "50", price: "450" })).rejects.toMatchObject({ code: "SLAB_EXISTS" });
    await updateSlabPrice(session, id, s50, { price: "450" });
    await setSlabActive(session, id, s50, false);
    await addSlab(session, id, { minQty: "50", price: "452" });
    // The retired one can't come back while a new 50+ slab is active.
    await expect(setSlabActive(session, id, s50, true)).rejects.toMatchObject({ code: "SLAB_EXISTS" });
    const actions = (await db.owner.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, s50))).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["pricing.slab_added", "pricing.slab_changed", "pricing.slab_retired"]));
    const rows = await db.owner.select().from(priceSlabs).where(eq(priceSlabs.productId, id));
    expect(rows.filter((row) => row.isActive)).toHaveLength(2);
    expect(rows).toHaveLength(3);
  });
});

describe("customer rules", () => {
  it("enforces 0.1%–30%, a product for fixed prices, and one active rule per scope", async () => {
    const { id } = await pipe();
    const session = await owner();
    const customer = await addCustomer(shopA, "wholesale");
    for (const percent of ["0", "0.05", "31", "abc"]) {
      await expect(addCustomerRule(session, { kind: "pct", customerId: customer, productId: "", percent }), percent).rejects.toSatisfy(isInvalidInput);
    }
    await expect(addCustomerRule(session, { kind: "fixed", customerId: customer, productId: "", price: "400", minQty: "0" })).rejects.toSatisfy(isInvalidInput);
    await addCustomerRule(session, { kind: "pct", customerId: customer, productId: "", percent: "1" });
    await expect(addCustomerRule(session, { kind: "pct", customerId: customer, productId: "", percent: "2" })).rejects.toMatchObject({ code: "RULE_EXISTS" });
    await addCustomerRule(session, { kind: "fixed", customerId: customer, productId: id, price: "430", minQty: "100" });
    await expect(addCustomerRule(session, { kind: "fixed", customerId: customer, productId: id, price: "425", minQty: "100" })).rejects.toMatchObject({ code: "RULE_EXISTS" });
    await expect(addCustomerRule(session, { kind: "fixed", customerId: customer, productId: id, price: "380", minQty: "0" })).rejects.toMatchObject({ code: "BELOW_COST" });
  });

  it("changes and retires rules with audit rows", async () => {
    const { id } = await pipe();
    const session = await owner();
    const customer = await addCustomer(shopA, "wholesale");
    const { id: ruleId } = await addCustomerRule(session, { kind: "fixed", customerId: customer, productId: id, price: "430", minQty: "100" });
    await updateCustomerRule(session, ruleId, { price: "428", minQty: "120" });
    await setCustomerRuleActive(session, ruleId, false);
    const [row] = await db.owner.select().from(customerPriceRules).where(eq(customerPriceRules.id, ruleId));
    expect(row).toMatchObject({ value: 42800, minQty: "120.000", isActive: false });
    const actions = (await db.owner.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, ruleId))).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["pricing.rule_added", "pricing.rule_changed", "pricing.rule_retired"]));
    const rules = await listRulesForProduct(session, id);
    expect(rules.find((rule) => rule.id === ruleId)).toMatchObject({ customerName: "wholesale customer", isActive: false, minQty: "120" });
  });
});

describe("permissions", () => {
  it("only the owner manages slabs and rules; billing staff may quote", async () => {
    const { id, s50 } = await pipe();
    for (const role of ["manager", "cashier", "inventory"] as const) {
      const { session } = await signInAs(shopA.users[role]);
      await expect(addSlab(session, id, { minQty: "300", price: "430" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(updateSlabPrice(session, id, s50, { price: "450" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setSlabActive(session, id, s50, false)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(addCustomerRule(session, { kind: "pct", customerId: wholesaler, productId: "", percent: "1" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listSlabs(session, id)).rejects.toBeInstanceOf(ForbiddenError);
    }
    const { session: cashier } = await signInAs(shopA.users.cashier);
    const result = await quoteForSession(cashier, { productId: id, unit: "pc", quantity: "100", customerId: wholesaler });
    expect(result.baseRatePaise).toBe(44000);
    expect(result.belowCost).toBeNull();
    const { session: inventory } = await signInAs(shopA.users.inventory);
    await expect(quoteForSession(inventory, { productId: id, unit: "pc", quantity: "1" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("shop isolation", () => {
  it("cannot quote, change or attach rules to another shop's products, slabs, rules or customers", async () => {
    const other = await pipe(shopB);
    const otherCustomer = await addCustomer(shopB, "wholesale");
    const { id: otherRule } = await addCustomerRule(await owner(shopB), { kind: "pct", customerId: otherCustomer, productId: "", percent: "5" });
    const mine = await pipe();
    const session = await owner();

    await expect(quote({ productId: other.id, unit: "pc", quantity: "1" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(quote({ productId: mine.id, unit: "pc", quantity: "1", customerId: otherCustomer })).rejects.toBeInstanceOf(NotFoundError);
    await expect(addSlab(session, other.id, { minQty: "300", price: "430" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateSlabPrice(session, other.id, other.s50, { price: "1" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateSlabPrice(session, mine.id, other.s50, { price: "450" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(setSlabActive(session, other.id, other.s50, false)).rejects.toBeInstanceOf(NotFoundError);
    await expect(addCustomerRule(session, { kind: "pct", customerId: otherCustomer, productId: "", percent: "1" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(addCustomerRule(session, { kind: "fixed", customerId: wholesaler, productId: other.id, price: "430", minQty: "0" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateCustomerRule(session, otherRule, { percent: "9" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(setCustomerRuleActive(session, otherRule, false)).rejects.toBeInstanceOf(NotFoundError);

    const [slab] = await db.owner.select().from(priceSlabs).where(eq(priceSlabs.id, other.s50));
    expect(slab).toMatchObject({ pricePaise: 45500, isActive: true, shopId: shopB.shopId });
    const [rule] = await db.owner.select().from(customerPriceRules).where(eq(customerPriceRules.id, otherRule));
    expect(rule).toMatchObject({ value: 500, isActive: true });
    expect((await listRulesForProduct(session, mine.id)).some((r) => r.id === otherRule)).toBe(false);
  });
});
