import { and, asc, count, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import { hasPermission, requirePermission, type SessionContext } from "@/modules/identity";
import { getDb, withTransaction, type Transaction } from "@/server/db";
import { isUniqueViolation } from "@/server/db-errors";
import { ConflictError, NotFoundError } from "@/server/errors";
import { CATALOG_MANAGE, CATALOG_VIEW, COST_VIEW } from "./permissions";
import { categories, productCostHistory, productUnits, products, units } from "./schema";
import { requireActiveUnit } from "./units";
import { productInputSchema, productUpdateSchema, type ProductInput } from "./validation";

export const PRODUCT_PAGE_SIZE = 50;

export type ProductStatusFilter = "active" | "inactive" | "all";

export type Conversion = { id: string; unit: string; unitName: string; factor: string; isActive: boolean };

export type ProductListItem = {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  categoryName: string | null;
  baseUnit: string;
  baseUnitName: string;
  retailPaise: number;
  wholesalePaise: number;
  isActive: boolean;
  conversions: Conversion[];
};

export type ProductDetail = ProductListItem & {
  description: string | null;
  categoryId: string | null;
  hsn: string;
  gstRateBp: number;
  /** null when unknown, or when the viewer may not see cost prices (see costVisible). */
  costPaise: number | null;
  costVisible: boolean;
  version: number;
};

const actorOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId, role: session.role });

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Factors come back from numeric(12,3) as "50.000"; show "50". */
export function trimFactor(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

async function conversionsFor(db: ReturnType<typeof getDb> | Transaction, shopId: string, productIds: string[], includeInactive: boolean) {
  if (productIds.length === 0) return new Map<string, Conversion[]>();
  const rows = await db
    .select({
      id: productUnits.id,
      productId: productUnits.productId,
      unit: productUnits.unit,
      unitName: units.name,
      factor: productUnits.factor,
      isActive: productUnits.isActive,
    })
    .from(productUnits)
    .innerJoin(products, eq(products.id, productUnits.productId))
    .innerJoin(units, and(eq(units.shopId, products.shopId), eq(units.code, productUnits.unit)))
    .where(
      and(
        eq(products.shopId, shopId),
        inArray(productUnits.productId, productIds),
        includeInactive ? undefined : eq(productUnits.isActive, true),
      ),
    )
    .orderBy(asc(productUnits.factor));
  const byProduct = new Map<string, Conversion[]>();
  for (const row of rows) {
    const list = byProduct.get(row.productId) ?? [];
    list.push({ id: row.id, unit: row.unit, unitName: row.unitName, factor: trimFactor(row.factor), isActive: row.isActive });
    byProduct.set(row.productId, list);
  }
  return byProduct;
}

export type ProductFilters = { q?: string; categoryId?: string; status?: ProductStatusFilter; page?: number };
export type ProductPage = { items: ProductListItem[]; total: number; page: number; pageSize: number };

/** Search and filter the shop's products. Inactive products are hidden unless asked for. */
export async function listProducts(session: SessionContext, filters: ProductFilters = {}): Promise<ProductPage> {
  await requirePermission(session, CATALOG_VIEW);
  return searchShopProducts(session.shopId, filters);
}

/**
 * The search behind listProducts, for other modules (pricing) that check their own permission
 * first. Always scoped to `shopId`, which must come from the session.
 */
export async function searchShopProducts(shopId: string, filters: ProductFilters = {}): Promise<ProductPage> {
  const status = filters.status ?? "active";
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const conditions: (SQL | undefined)[] = [eq(products.shopId, shopId)];
  if (status !== "all") conditions.push(eq(products.isActive, status === "active"));
  if (filters.categoryId && /^[0-9a-f-]{36}$/i.test(filters.categoryId)) conditions.push(eq(products.categoryId, filters.categoryId));
  const q = filters.q?.trim().slice(0, 60);
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    conditions.push(or(ilike(products.name, pattern), ilike(products.sku, pattern), ilike(products.barcode, pattern)));
  }
  const where = and(...conditions);
  const db = getDb();

  const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(products).where(where);
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      sku: products.sku,
      barcode: products.barcode,
      categoryName: categories.name,
      baseUnit: products.baseUnit,
      baseUnitName: units.name,
      retailPaise: products.retailPaise,
      wholesalePaise: products.wholesalePaise,
      isActive: products.isActive,
    })
    .from(products)
    .innerJoin(units, and(eq(units.shopId, products.shopId), eq(units.code, products.baseUnit)))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(where)
    .orderBy(asc(products.name), asc(products.sku))
    .limit(PRODUCT_PAGE_SIZE)
    .offset((page - 1) * PRODUCT_PAGE_SIZE);

  const conversions = await conversionsFor(db, shopId, rows.map((row) => row.id), false);
  return {
    items: rows.map((row) => ({ ...row, conversions: conversions.get(row.id) ?? [] })),
    total,
    page,
    pageSize: PRODUCT_PAGE_SIZE,
  };
}

export async function listCategories(session: SessionContext): Promise<{ id: string; name: string }[]> {
  await requirePermission(session, CATALOG_VIEW);
  return getDb().select({ id: categories.id, name: categories.name }).from(categories).where(eq(categories.shopId, session.shopId)).orderBy(asc(categories.name));
}

/** A product of the caller's shop. Products of other shops are reported as not found. */
export async function getProduct(session: SessionContext, productId: string): Promise<ProductDetail> {
  await requirePermission(session, CATALOG_VIEW);
  if (!/^[0-9a-f-]{36}$/i.test(productId)) throw new NotFoundError("Product not found.");
  const db = getDb();
  const [row] = await db
    .select({
      id: products.id,
      name: products.name,
      sku: products.sku,
      barcode: products.barcode,
      description: products.description,
      categoryId: products.categoryId,
      categoryName: categories.name,
      baseUnit: products.baseUnit,
      baseUnitName: units.name,
      hsn: products.hsn,
      gstRateBp: products.gstRateBp,
      retailPaise: products.retailPaise,
      wholesalePaise: products.wholesalePaise,
      costPaise: products.costPaise,
      isActive: products.isActive,
      version: products.version,
    })
    .from(products)
    .innerJoin(units, and(eq(units.shopId, products.shopId), eq(units.code, products.baseUnit)))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(and(eq(products.id, productId), eq(products.shopId, session.shopId)))
    .limit(1);
  if (!row) throw new NotFoundError("Product not found.");
  const costVisible = await hasPermission(session, COST_VIEW);
  const conversions = await conversionsFor(db, session.shopId, [row.id], true);
  return { ...row, costPaise: costVisible ? row.costPaise : null, costVisible, conversions: conversions.get(row.id) ?? [] };
}

/** Finds the shop's category by name (case-insensitive) or creates it. */
async function resolveCategory(tx: Transaction, shopId: string, name: string | undefined): Promise<string | null> {
  if (!name) return null;
  const [existing] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.shopId, shopId), sql`lower(${categories.name}) = lower(${name})`))
    .limit(1);
  if (existing) return existing.id;
  const [created] = await tx.insert(categories).values({ shopId, name }).onConflictDoNothing().returning({ id: categories.id });
  if (created) return created.id;
  const [raced] = await tx.select({ id: categories.id }).from(categories).where(and(eq(categories.shopId, shopId), eq(categories.name, name))).limit(1);
  return raced?.id ?? null;
}

function duplicateError(error: unknown): ConflictError | null {
  if (isUniqueViolation(error, "products_shop_sku_key")) return new ConflictError("SKU_IN_USE", "Another product in your shop already uses this product code.");
  if (isUniqueViolation(error, "products_shop_barcode_key")) return new ConflictError("BARCODE_IN_USE", "Another product in your shop already uses this barcode.");
  return null;
}

type AuditableProduct = Omit<ProductInput, "barcode" | "description" | "categoryName"> & {
  barcode?: string | null;
  description?: string | null;
  categoryId: string | null;
};

/** The product fields recorded in the audit log (cost included; the log is owner-only). */
function auditFields(data: AuditableProduct) {
  return {
    name: data.name,
    sku: data.sku,
    barcode: data.barcode ?? null,
    categoryId: data.categoryId,
    description: data.description ?? null,
    baseUnit: data.baseUnit,
    hsn: data.hsn,
    gstRateBp: data.gstRateBp,
    retailPaise: data.retailPaise,
    wholesalePaise: data.wholesalePaise,
    costPaise: data.costPaise,
  };
}

/** The rate must be one the shop uses (Settings → GST). Loaded lazily: settings imports this module. */
async function requireShopGstRate(tx: Transaction, shopId: string, rate: number) {
  const { loadTaxSettings } = await import("@/modules/settings");
  const { gstRatesBp } = await loadTaxSettings(tx, shopId);
  if (!gstRatesBp.includes(rate)) throw new ConflictError("GST_RATE_NOT_ENABLED", `${rate / 100}% isn't one of this shop's GST rates. The owner can add it in Settings → GST.`, { fieldErrors: { gstRateBp: "Not one of this shop's GST rates." } });
}

export async function createProduct(session: SessionContext, input: unknown): Promise<{ id: string }> {
  await requirePermission(session, CATALOG_MANAGE);
  const data = productInputSchema.parse(input);
  return withTransaction(async (tx) => {
    await requireShopGstRate(tx, session.shopId, data.gstRateBp);
    await requireActiveUnit(tx, session.shopId, data.baseUnit, "base unit");
    const categoryId = await resolveCategory(tx, session.shopId, data.categoryName);
    let row: { id: string } | undefined;
    try {
      [row] = await tx
        .insert(products)
        .values({
          shopId: session.shopId,
          name: data.name,
          sku: data.sku,
          barcode: data.barcode ?? null,
          description: data.description ?? null,
          categoryId,
          baseUnit: data.baseUnit,
          hsn: data.hsn,
          gstRateBp: data.gstRateBp,
          retailPaise: data.retailPaise,
          wholesalePaise: data.wholesalePaise,
          costPaise: data.costPaise,
        })
        .returning({ id: products.id });
    } catch (error) {
      throw duplicateError(error) ?? error;
    }
    const productId = row!.id;
    if (data.costPaise !== null) {
      await tx.insert(productCostHistory).values({ productId, costPaise: data.costPaise, sourceType: "manual", effectiveAt: sql`now()` });
    }
    await recordAudit(tx, actorOf(session), { action: "catalog.product_created", entityType: "product", entityId: productId, after: auditFields({ ...data, categoryId }) });
    return { id: productId };
  });
}

/**
 * Updates a product. `version` must match what the person last saw, so two people editing the same
 * product cannot silently overwrite each other. The base unit can only change while no packaging
 * units are set up, because packaging sizes are expressed in the base unit.
 */
export async function updateProduct(session: SessionContext, productId: string, input: unknown): Promise<{ version: number }> {
  await requirePermission(session, CATALOG_MANAGE);
  const data = productUpdateSchema.parse(input);
  return withTransaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, productId), eq(products.shopId, session.shopId)))
      .limit(1)
      .for("update");
    if (!current) throw new NotFoundError("Product not found.");
    if (data.gstRateBp !== current.gstRateBp) await requireShopGstRate(tx, session.shopId, data.gstRateBp);
    if (current.version !== data.version) {
      throw new ConflictError("VERSION_CONFLICT", "Someone else changed this product while you were editing. Reload the page to see the latest details.");
    }
    if (data.baseUnit !== current.baseUnit) {
      const [packaging] = await tx.select({ n: count() }).from(productUnits).where(eq(productUnits.productId, productId));
      if ((packaging?.n ?? 0) > 0) {
        throw new ConflictError("BASE_UNIT_LOCKED", "This product already has pack sizes set up in its current unit, so the base unit can't be changed.");
      }
      await requireActiveUnit(tx, session.shopId, data.baseUnit, "base unit");
    }
    const categoryId = await resolveCategory(tx, session.shopId, data.categoryName);
    // Cost is only changed by people who can see it; otherwise the stored cost is kept.
    const canSeeCost = await hasPermission(session, COST_VIEW, tx);
    const costPaise = canSeeCost ? data.costPaise : current.costPaise;
    const nextVersion = current.version + 1;
    try {
      await tx
        .update(products)
        .set({
          name: data.name,
          sku: data.sku,
          barcode: data.barcode ?? null,
          description: data.description ?? null,
          categoryId,
          baseUnit: data.baseUnit,
          hsn: data.hsn,
          gstRateBp: data.gstRateBp,
          retailPaise: data.retailPaise,
          wholesalePaise: data.wholesalePaise,
          costPaise,
          version: nextVersion,
        })
        .where(and(eq(products.id, productId), eq(products.shopId, session.shopId)));
    } catch (error) {
      throw duplicateError(error) ?? error;
    }
    if (costPaise !== null && costPaise !== current.costPaise) {
      await tx.insert(productCostHistory).values({ productId, costPaise, sourceType: "manual", effectiveAt: sql`now()` });
    }
    const before = auditFields(current);
    const after = auditFields({ ...data, costPaise, categoryId });
    const changedKeys = (Object.keys(after) as (keyof typeof after)[]).filter((key) => before[key] !== after[key]);
    await recordAudit(tx, actorOf(session), {
      action: "catalog.product_updated",
      entityType: "product",
      entityId: productId,
      before: Object.fromEntries(changedKeys.map((key) => [key, before[key]])),
      after: Object.fromEntries(changedKeys.map((key) => [key, after[key]])),
    });
    return { version: nextVersion };
  });
}

/** Products are never deleted (they may appear on bills); they are switched off instead. */
export async function setProductActive(session: SessionContext, productId: string, active: boolean): Promise<void> {
  await requirePermission(session, CATALOG_MANAGE);
  await withTransaction(async (tx) => {
    const [row] = await tx
      .update(products)
      .set({ isActive: active, version: sql`${products.version} + 1` })
      .where(and(eq(products.id, productId), eq(products.shopId, session.shopId)))
      .returning({ id: products.id });
    if (!row) throw new NotFoundError("Product not found.");
    await recordAudit(tx, actorOf(session), {
      action: active ? "catalog.product_activated" : "catalog.product_deactivated",
      entityType: "product",
      entityId: productId,
    });
  });
}

/** Every product of the shop for a CSV export, in import-template order. Cost only for `cost.view`. */
export async function exportProducts(session: SessionContext) {
  await requirePermission(session, CATALOG_VIEW);
  const costVisible = await hasPermission(session, COST_VIEW);
  const rows = await getDb()
    .select({ name: products.name, sku: products.sku, baseUnit: products.baseUnit, hsn: products.hsn, gstRateBp: products.gstRateBp, retailPaise: products.retailPaise, wholesalePaise: products.wholesalePaise, costPaise: products.costPaise, categoryName: categories.name, barcode: products.barcode, description: products.description, isActive: products.isActive })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(eq(products.shopId, session.shopId))
    .orderBy(asc(products.name));
  return { costVisible, rows: rows.map((row) => ({ ...row, costPaise: costVisible ? row.costPaise : null })) };
}

/** Whether the shop has added any product yet (the setup checklist). No permission check: yes/no only. */
export async function shopHasProducts(shopId: string): Promise<boolean> {
  const [row] = await getDb().select({ id: products.id }).from(products).where(eq(products.shopId, shopId)).limit(1);
  return Boolean(row);
}
