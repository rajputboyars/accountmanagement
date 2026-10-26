import { and, asc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { getDb, type Database, type Transaction } from "@/server/db";
import { parseQuantity, type Milli } from "@/shared/quantity";
import { categories, productCostHistory, productUnits, products, units } from "./schema";

/** What the inventory module needs to know about a product. Callers check permissions first. */
export type ProductStockInputs = {
  id: string;
  name: string;
  sku: string;
  categoryId: string | null;
  categoryName: string | null;
  isActive: boolean;
  baseUnit: string;
  baseUnitName: string;
  baseAllowsDecimal: boolean;
  reorderLevel: Milli;
  gstRateBp: number;
  /** Always loaded; the inventory module decides who may see it. */
  costPaise: number | null;
};

export type ProductStockUnits = ProductStockInputs & { saleUnits: { code: string; name: string; factor: Milli }[] };

const columns = {
  id: products.id,
  name: products.name,
  sku: products.sku,
  categoryId: products.categoryId,
  categoryName: categories.name,
  isActive: products.isActive,
  baseUnit: products.baseUnit,
  baseUnitName: units.name,
  baseAllowsDecimal: units.allowDecimal,
  reorderLevel: products.reorderLevel,
  gstRateBp: products.gstRateBp,
  costPaise: products.costPaise,
};

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

const toInputs = (row: Omit<ProductStockInputs, "reorderLevel"> & { reorderLevel: string }): ProductStockInputs => ({ ...row, reorderLevel: parseQuantity(row.reorderLevel) });

/**
 * Every product of `shopId` matching the filters, unpaged (a shop has hundreds to a few thousand
 * products). Inactive products are included only when asked. No permission check.
 */
export async function listShopProductsForStock(
  shopId: string,
  filters: { q?: string; categoryId?: string; includeInactive?: boolean } = {},
  db: Database | Transaction = getDb(),
): Promise<ProductStockInputs[]> {
  const conditions: (SQL | undefined)[] = [eq(products.shopId, shopId)];
  if (!filters.includeInactive) conditions.push(eq(products.isActive, true));
  if (filters.categoryId && /^[0-9a-f-]{36}$/i.test(filters.categoryId)) conditions.push(eq(products.categoryId, filters.categoryId));
  const q = filters.q?.trim().slice(0, 60);
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    conditions.push(or(ilike(products.name, pattern), ilike(products.sku, pattern), ilike(products.barcode, pattern)));
  }
  const rows = await db
    .select(columns)
    .from(products)
    .innerJoin(units, and(eq(units.shopId, products.shopId), eq(units.code, products.baseUnit)))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(and(...conditions))
    .orderBy(asc(products.name), asc(products.sku));
  return rows.map(toInputs);
}

async function attachUnits(db: Database | Transaction, shopId: string, rows: ProductStockInputs[]): Promise<ProductStockUnits[]> {
  if (rows.length === 0) return [];
  const packs = await db
    .select({ productId: productUnits.productId, code: productUnits.unit, name: units.name, factor: productUnits.factor })
    .from(productUnits)
    .innerJoin(units, and(eq(units.shopId, shopId), eq(units.code, productUnits.unit)))
    .where(and(inArray(productUnits.productId, rows.map((row) => row.id)), eq(productUnits.isActive, true), eq(units.isActive, true)));
  return rows.map((row) => ({
    ...row,
    saleUnits: packs.filter((pack) => pack.productId === row.id).map((pack) => ({ code: pack.code, name: pack.name, factor: parseQuantity(pack.factor) })),
  }));
}

/** Products of `shopId` with their active pack sizes. Ids of other shops are simply missing from the result. */
export async function loadProductsForStock(shopId: string, productIds: string[], db: Database | Transaction = getDb()): Promise<ProductStockUnits[]> {
  const ids = productIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (ids.length === 0) return [];
  const rows = await db
    .select(columns)
    .from(products)
    .innerJoin(units, and(eq(units.shopId, products.shopId), eq(units.code, products.baseUnit)))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(and(eq(products.shopId, shopId), inArray(products.id, ids)));
  return attachUnits(db, shopId, rows.map(toInputs));
}

/**
 * Locks the product rows (FOR UPDATE, in product-id order so two writers never deadlock) and
 * returns them with their pack sizes. Stock writes for a product run one at a time behind this
 * lock, so "has this product already been opened?" cannot race. Ids of other shops are missing.
 */
export async function lockProductsForStock(tx: Transaction, shopId: string, productIds: string[]): Promise<ProductStockUnits[]> {
  const ids = [...new Set(productIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)))].sort();
  if (ids.length === 0) return [];
  const locked = await tx
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.shopId, shopId), inArray(products.id, ids)))
    .orderBy(asc(products.id))
    .for("update");
  return loadProductsForStock(shopId, locked.map((row) => row.id), tx);
}

/**
 * Sets a product's cost price after a goods receipt (weighted average, worked out by the caller)
 * and records it in the cost history. Bumps the product version so an edit form opened before the
 * receipt can't silently overwrite it. The caller holds the product lock (lockProductsForStock).
 */
export async function applyReceivedCost(tx: Transaction, shopId: string, productId: string, costPaise: number, goodsReceiptId: string): Promise<void> {
  await tx
    .update(products)
    .set({ costPaise, version: sql`${products.version} + 1` })
    .where(and(eq(products.shopId, shopId), eq(products.id, productId)));
  await tx.insert(productCostHistory).values({ productId, costPaise, sourceType: "goods_receipt", sourceId: goodsReceiptId, effectiveAt: new Date() });
}
