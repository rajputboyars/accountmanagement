import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import { loadProductNames, loadProductPricingInputs, searchShopProducts, type ProductFilters, type ProductPricingInputs } from "@/modules/catalog";
import { hasPermission, requirePermission, type SessionContext } from "@/modules/identity";
import { findCustomer, listActiveCustomers, loadCustomerNames } from "@/modules/parties";
import { getDb, withTransaction, type Transaction } from "@/server/db";
import { isUniqueViolation } from "@/server/db-errors";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { formatPaise } from "@/shared/money";
import { formatBasisPoints } from "@/shared/pricing-engine";
import { formatQuantity, isWholeQuantity, parseQuantity, toDbQuantity, type Milli } from "@/shared/quantity";
import { COST_VIEW, PRICING_MANAGE } from "./permissions";
import { customerPriceRules, priceSlabs } from "./schema";
import { customerRuleInputSchema, fixedRuleUpdateSchema, pctRuleUpdateSchema, slabInputSchema, slabPriceSchema } from "./validation";

/**
 * Slabs and customer rules (spec §3). Every write needs pricing.edit, runs in one transaction with
 * its audit row, and only ever retires rows (is_active = false); nothing is deleted. Partial unique
 * indexes allow one active slab per minimum quantity and one active rule per scope, so two
 * active rows can never compete for the same quote.
 */

const actorOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId, role: session.role });
const isId = (value: string) => /^[0-9a-f-]{36}$/i.test(value);

export type Slab = { id: string; minQty: string; pricePaise: number; isActive: boolean; belowCost: boolean | null };
export type CustomerRule = {
  id: string;
  customerId: string;
  customerName: string;
  productId: string | null;
  productName: string | null;
  kind: "fixed" | "pct";
  /** fixed: paise per base unit; pct: basis points. */
  value: number;
  minQty: string;
  isActive: boolean;
};

/** Below-cost check (spec P2): blocked unless the owner confirms. Lines with no cost skip it. */
async function checkCost(session: SessionContext, product: ProductPricingInputs, pricePaise: number, confirmed: boolean, what: string): Promise<boolean> {
  if (product.costPaise === null || pricePaise >= product.costPaise) return false;
  if (confirmed) return true;
  const showCost = await hasPermission(session, COST_VIEW);
  throw new ConflictError(
    "BELOW_COST",
    `This ${what} is below the cost price${showCost ? ` of ${formatPaise(product.costPaise, { withPaise: true })}` : ""}. Selling below cost needs the owner's confirmation: tick "I confirm" to save it anyway.`,
  );
}

function checkWholeForUnit(product: ProductPricingInputs, minQty: Milli) {
  if (!product.baseAllowsDecimal && !isWholeQuantity(minQty)) {
    throw new ValidationError(`${product.baseUnitName} can't be split, so the minimum quantity must be a whole number.`);
  }
}

// ── Slabs ────────────────────────────────────────────────────────────────────

export async function listSlabs(session: SessionContext, productId: string): Promise<Slab[]> {
  await requirePermission(session, PRICING_MANAGE);
  const product = await loadProductPricingInputs(session.shopId, productId);
  const rows = await getDb()
    .select({ id: priceSlabs.id, minQty: priceSlabs.minQty, pricePaise: priceSlabs.pricePaise, isActive: priceSlabs.isActive })
    .from(priceSlabs)
    .where(and(eq(priceSlabs.shopId, session.shopId), eq(priceSlabs.productId, product.id)))
    .orderBy(asc(priceSlabs.minQty), asc(priceSlabs.createdAt));
  const showCost = await hasPermission(session, COST_VIEW);
  return rows.map((row) => ({
    ...row,
    minQty: formatQuantity(parseQuantity(row.minQty)),
    belowCost: showCost && product.costPaise !== null ? row.pricePaise < product.costPaise : null,
  }));
}

/** Active slabs of a product as the engine needs them. No permission check: callers do it. */
export async function activeSlabsFor(shopId: string, productId: string, db: ReturnType<typeof getDb> | Transaction = getDb()) {
  const rows = await db
    .select({ id: priceSlabs.id, minQty: priceSlabs.minQty, pricePaise: priceSlabs.pricePaise })
    .from(priceSlabs)
    .where(and(eq(priceSlabs.shopId, shopId), eq(priceSlabs.productId, productId), eq(priceSlabs.isActive, true)));
  return rows.map((row) => ({ id: row.id, minQty: parseQuantity(row.minQty), pricePaise: row.pricePaise }));
}

function slabConflict(error: unknown, minQty: Milli, baseUnit: string): unknown {
  if (isUniqueViolation(error, "price_slabs_active_min_qty_key")) {
    return new ConflictError("SLAB_EXISTS", `There is already an active slab from ${formatQuantity(minQty)} ${baseUnit}. Change its price instead.`);
  }
  return error;
}

function checkSlabPrice(product: ProductPricingInputs, pricePaise: number) {
  if (pricePaise > product.wholesalePaise) {
    throw new ValidationError(`A slab can't be above the wholesale price (${formatPaise(product.wholesalePaise, { withPaise: true })}).`);
  }
}

export async function addSlab(session: SessionContext, productId: string, input: unknown): Promise<{ id: string }> {
  await requirePermission(session, PRICING_MANAGE);
  const data = slabInputSchema.parse(input);
  return withTransaction(async (tx) => {
    const product = await loadProductPricingInputs(session.shopId, productId, tx);
    if (data.minQty <= BigInt(1000)) throw new ValidationError(`The minimum quantity must be more than 1 ${product.baseUnit}.`);
    checkWholeForUnit(product, data.minQty);
    checkSlabPrice(product, data.price);
    const belowCost = await checkCost(session, product, data.price, data.confirmBelowCost, "slab price");
    try {
      const [row] = await tx
        .insert(priceSlabs)
        .values({ shopId: session.shopId, productId: product.id, minQty: toDbQuantity(data.minQty), pricePaise: data.price })
        .returning({ id: priceSlabs.id });
      await recordAudit(tx, actorOf(session), {
        action: "pricing.slab_added",
        entityType: "price_slab",
        entityId: row!.id,
        after: { productId: product.id, minQty: formatQuantity(data.minQty), pricePaise: data.price, belowCostConfirmed: belowCost },
      });
      return { id: row!.id };
    } catch (error) {
      throw slabConflict(error, data.minQty, product.baseUnit);
    }
  });
}

async function lockSlab(tx: Transaction, session: SessionContext, productId: string, slabId: string) {
  if (!isId(slabId) || !isId(productId)) throw new NotFoundError("Slab not found.");
  const [slab] = await tx
    .select()
    .from(priceSlabs)
    .where(and(eq(priceSlabs.id, slabId), eq(priceSlabs.productId, productId), eq(priceSlabs.shopId, session.shopId)))
    .limit(1)
    .for("update");
  if (!slab) throw new NotFoundError("Slab not found.");
  return slab;
}

export async function updateSlabPrice(session: SessionContext, productId: string, slabId: string, input: unknown): Promise<void> {
  await requirePermission(session, PRICING_MANAGE);
  const data = slabPriceSchema.parse(input);
  await withTransaction(async (tx) => {
    const slab = await lockSlab(tx, session, productId, slabId);
    if (!slab.isActive) throw new ConflictError("SLAB_RETIRED", "This slab is retired. Use it again before changing its price.");
    const product = await loadProductPricingInputs(session.shopId, productId, tx);
    checkSlabPrice(product, data.price);
    const belowCost = await checkCost(session, product, data.price, data.confirmBelowCost, "slab price");
    if (slab.pricePaise === data.price) return;
    await tx.update(priceSlabs).set({ pricePaise: data.price }).where(eq(priceSlabs.id, slab.id));
    await recordAudit(tx, actorOf(session), {
      action: "pricing.slab_changed",
      entityType: "price_slab",
      entityId: slab.id,
      before: { pricePaise: slab.pricePaise },
      after: { pricePaise: data.price, belowCostConfirmed: belowCost },
    });
  });
}

export async function setSlabActive(session: SessionContext, productId: string, slabId: string, active: boolean): Promise<void> {
  await requirePermission(session, PRICING_MANAGE);
  await withTransaction(async (tx) => {
    const slab = await lockSlab(tx, session, productId, slabId);
    if (slab.isActive === active) return;
    if (active) {
      // Bringing a slab back checks it against today's wholesale price.
      checkSlabPrice(await loadProductPricingInputs(session.shopId, productId, tx), slab.pricePaise);
    }
    try {
      await tx.update(priceSlabs).set({ isActive: active }).where(eq(priceSlabs.id, slab.id));
    } catch (error) {
      throw slabConflict(error, parseQuantity(slab.minQty), "base units");
    }
    await recordAudit(tx, actorOf(session), {
      action: active ? "pricing.slab_reactivated" : "pricing.slab_retired",
      entityType: "price_slab",
      entityId: slab.id,
      before: { isActive: slab.isActive },
      after: { isActive: active },
    });
  });
}

// ── Customer rules ───────────────────────────────────────────────────────────

const ruleColumns = {
  id: customerPriceRules.id,
  customerId: customerPriceRules.customerId,
  productId: customerPriceRules.productId,
  kind: customerPriceRules.kind,
  value: customerPriceRules.value,
  minQty: customerPriceRules.minQty,
  isActive: customerPriceRules.isActive,
};

async function withNames(shopId: string, rows: (Omit<CustomerRule, "productName" | "customerName" | "minQty"> & { minQty: string })[]): Promise<CustomerRule[]> {
  const [products, customerNames] = await Promise.all([
    loadProductNames(shopId, [...new Set(rows.flatMap((row) => (row.productId ? [row.productId] : [])))]),
    loadCustomerNames(shopId, [...new Set(rows.map((row) => row.customerId))]),
  ]);
  return rows
    .map((row) => ({
      ...row,
      minQty: formatQuantity(parseQuantity(row.minQty)),
      customerName: customerNames.get(row.customerId) ?? "Unknown customer",
      productName: row.productId ? (products.get(row.productId)?.name ?? null) : null,
    }))
    .sort((a, b) => a.customerName.localeCompare(b.customerName) || a.kind.localeCompare(b.kind) || Number(parseQuantity(a.minQty) - parseQuantity(b.minQty)));
}

/** Rules that can affect this product: rules naming it, and %-off rules for all products. */
export async function listRulesForProduct(session: SessionContext, productId: string): Promise<CustomerRule[]> {
  await requirePermission(session, PRICING_MANAGE);
  const product = await loadProductPricingInputs(session.shopId, productId);
  const rows = await getDb()
    .select(ruleColumns)
    .from(customerPriceRules)
    .where(and(eq(customerPriceRules.shopId, session.shopId), or(eq(customerPriceRules.productId, product.id), isNull(customerPriceRules.productId))));
  return withNames(session.shopId, rows);
}

/** %-off rules that apply to every product. */
export async function listAllProductRules(session: SessionContext): Promise<CustomerRule[]> {
  await requirePermission(session, PRICING_MANAGE);
  const rows = await getDb()
    .select(ruleColumns)
    .from(customerPriceRules)
    .where(and(eq(customerPriceRules.shopId, session.shopId), isNull(customerPriceRules.productId)));
  return withNames(session.shopId, rows);
}

/** Active rules of one customer for one product (or all products), as the engine needs them. No permission check. */
export async function activeRulesFor(shopId: string, customerId: string, productId: string, db: ReturnType<typeof getDb> | Transaction = getDb()) {
  const rows = await db
    .select({ id: customerPriceRules.id, kind: customerPriceRules.kind, productId: customerPriceRules.productId, value: customerPriceRules.value, minQty: customerPriceRules.minQty })
    .from(customerPriceRules)
    .where(
      and(
        eq(customerPriceRules.shopId, shopId),
        eq(customerPriceRules.customerId, customerId),
        eq(customerPriceRules.isActive, true),
        or(eq(customerPriceRules.productId, productId), isNull(customerPriceRules.productId)),
      ),
    );
  return rows.map((row) =>
    row.kind === "fixed"
      ? { id: row.id, kind: "fixed" as const, productId: row.productId!, pricePaise: row.value, minQty: parseQuantity(row.minQty) }
      : { id: row.id, kind: "pct" as const, productId: row.productId, basisPoints: row.value },
  );
}

function ruleConflict(error: unknown, kind: "fixed" | "pct"): unknown {
  if (isUniqueViolation(error, "customer_price_rules_active_fixed_key")) {
    return new ConflictError("RULE_EXISTS", "This customer already has a special price for this product at that minimum quantity. Change it instead.");
  }
  if (isUniqueViolation(error, "customer_price_rules_active_pct_product_key") || isUniqueViolation(error, "customer_price_rules_active_pct_all_key")) {
    return new ConflictError("RULE_EXISTS", `This customer already has a ${kind === "pct" ? "%" : ""} discount for the same products. Change it instead of adding another.`);
  }
  return error;
}

export async function addCustomerRule(session: SessionContext, input: unknown): Promise<{ id: string }> {
  await requirePermission(session, PRICING_MANAGE);
  const data = customerRuleInputSchema.parse(input);
  return withTransaction(async (tx) => {
    const customer = await findCustomer(session.shopId, data.customerId, tx);
    if (!customer.isActive) throw new ConflictError("CUSTOMER_INACTIVE", `${customer.name} is switched off.`);
    let values: typeof customerPriceRules.$inferInsert;
    let belowCost = false;
    if (data.kind === "fixed") {
      const product = await loadProductPricingInputs(session.shopId, data.productId, tx);
      if (!product.isActive) throw new ConflictError("PRODUCT_INACTIVE", `${product.name} is switched off.`);
      checkWholeForUnit(product, data.minQty);
      belowCost = await checkCost(session, product, data.price, data.confirmBelowCost, "special price");
      values = { shopId: session.shopId, customerId: customer.id, productId: product.id, kind: "fixed", value: data.price, minQty: toDbQuantity(data.minQty) };
    } else {
      if (data.productId) {
        const product = await loadProductPricingInputs(session.shopId, data.productId, tx);
        if (!product.isActive) throw new ConflictError("PRODUCT_INACTIVE", `${product.name} is switched off.`);
      }
      values = { shopId: session.shopId, customerId: customer.id, productId: data.productId, kind: "pct", value: data.percent, minQty: "0.000" };
    }
    try {
      const [row] = await tx.insert(customerPriceRules).values(values).returning({ id: customerPriceRules.id });
      await recordAudit(tx, actorOf(session), {
        action: "pricing.rule_added",
        entityType: "customer_price_rule",
        entityId: row!.id,
        after: { customerId: values.customerId, productId: values.productId, kind: values.kind, value: values.value, minQty: values.minQty, belowCostConfirmed: belowCost },
      });
      return { id: row!.id };
    } catch (error) {
      throw ruleConflict(error, data.kind);
    }
  });
}

async function lockRule(tx: Transaction, session: SessionContext, ruleId: string) {
  if (!isId(ruleId)) throw new NotFoundError("Rule not found.");
  const [rule] = await tx
    .select()
    .from(customerPriceRules)
    .where(and(eq(customerPriceRules.id, ruleId), eq(customerPriceRules.shopId, session.shopId)))
    .limit(1)
    .for("update");
  if (!rule) throw new NotFoundError("Rule not found.");
  return rule;
}

export async function updateCustomerRule(session: SessionContext, ruleId: string, input: unknown): Promise<void> {
  await requirePermission(session, PRICING_MANAGE);
  await withTransaction(async (tx) => {
    const rule = await lockRule(tx, session, ruleId);
    if (!rule.isActive) throw new ConflictError("RULE_RETIRED", "This rule is retired. Use it again before changing it.");
    let changes: { value: number; minQty?: string };
    let belowCost = false;
    if (rule.kind === "fixed") {
      const data = fixedRuleUpdateSchema.parse(input);
      const product = await loadProductPricingInputs(session.shopId, rule.productId!, tx);
      checkWholeForUnit(product, data.minQty);
      belowCost = await checkCost(session, product, data.price, data.confirmBelowCost, "special price");
      changes = { value: data.price, minQty: toDbQuantity(data.minQty) };
    } else {
      changes = { value: pctRuleUpdateSchema.parse(input).percent };
    }
    try {
      await tx.update(customerPriceRules).set(changes).where(eq(customerPriceRules.id, rule.id));
    } catch (error) {
      throw ruleConflict(error, rule.kind);
    }
    await recordAudit(tx, actorOf(session), {
      action: "pricing.rule_changed",
      entityType: "customer_price_rule",
      entityId: rule.id,
      before: { value: rule.value, minQty: rule.minQty },
      after: { ...changes, belowCostConfirmed: belowCost },
    });
  });
}

export async function setCustomerRuleActive(session: SessionContext, ruleId: string, active: boolean): Promise<void> {
  await requirePermission(session, PRICING_MANAGE);
  await withTransaction(async (tx) => {
    const rule = await lockRule(tx, session, ruleId);
    if (rule.isActive === active) return;
    try {
      await tx.update(customerPriceRules).set({ isActive: active }).where(eq(customerPriceRules.id, rule.id));
    } catch (error) {
      throw ruleConflict(error, rule.kind);
    }
    await recordAudit(tx, actorOf(session), {
      action: active ? "pricing.rule_reactivated" : "pricing.rule_retired",
      entityType: "customer_price_rule",
      entityId: rule.id,
      before: { isActive: rule.isActive },
      after: { isActive: active },
    });
  });
}

// ── Overview ─────────────────────────────────────────────────────────────────

/** The shop's products with their active slabs and special-price count, for the pricing list. */
export async function listPricingProducts(session: SessionContext, filters: ProductFilters = {}) {
  await requirePermission(session, PRICING_MANAGE);
  const page = await searchShopProducts(session.shopId, filters);
  const summaries = await summariesFor(session.shopId, page.items.map((item) => item.id));
  return { ...page, items: page.items.map((item) => ({ ...item, ...summaries.get(item.id)! })) };
}

async function summariesFor(shopId: string, productIds: string[]) {
  const result = new Map<string, { slabs: { minQty: string; pricePaise: number }[]; ruleCount: number }>();
  if (productIds.length === 0) return result;
  const db = getDb();
  const slabRows = await db
    .select({ productId: priceSlabs.productId, minQty: priceSlabs.minQty, pricePaise: priceSlabs.pricePaise })
    .from(priceSlabs)
    .where(and(eq(priceSlabs.shopId, shopId), eq(priceSlabs.isActive, true), inArray(priceSlabs.productId, productIds)))
    .orderBy(asc(priceSlabs.minQty));
  const ruleRows = await db
    .select({ productId: customerPriceRules.productId })
    .from(customerPriceRules)
    .where(and(eq(customerPriceRules.shopId, shopId), eq(customerPriceRules.isActive, true), inArray(customerPriceRules.productId, productIds)));
  for (const id of productIds) result.set(id, { slabs: [], ruleCount: 0 });
  for (const row of slabRows) result.get(row.productId)!.slabs.push({ minQty: formatQuantity(parseQuantity(row.minQty)), pricePaise: row.pricePaise });
  for (const row of ruleRows) result.get(row.productId!)!.ruleCount += 1;
  return result;
}

export async function listPricingCustomers(session: SessionContext) {
  await requirePermission(session, PRICING_MANAGE);
  return listActiveCustomers(session.shopId);
}

/** "Special ₹430.00 per pc from 100 pc" / "2% off". */
export function describeRule(rule: Pick<CustomerRule, "kind" | "value" | "minQty" | "productName">, baseUnit?: string): string {
  if (rule.kind === "pct") return `${formatBasisPoints(rule.value)} off ${rule.productName ?? "all products"}`;
  const from = rule.minQty !== "0" ? ` from ${rule.minQty} ${baseUnit ?? ""}`.trimEnd() : "";
  return `Special ${formatPaise(rule.value, { withPaise: true })}${baseUnit ? ` per ${baseUnit}` : ""}${from}`;
}

/** The product as the pricing screen shows it. Cost is null unless the viewer may see it. */
export async function getPricingProduct(session: SessionContext, productId: string) {
  await requirePermission(session, PRICING_MANAGE);
  const product = await loadProductPricingInputs(session.shopId, productId);
  const showCost = await hasPermission(session, COST_VIEW);
  return {
    ...product,
    costPaise: showCost ? product.costPaise : null,
    costVisible: showCost,
    saleUnits: product.saleUnits.map((unit) => ({ code: unit.code, name: unit.name, factor: formatQuantity(unit.factor) })),
  };
}
