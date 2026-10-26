import { and, eq, inArray } from "drizzle-orm";
import { getDb, type Database, type Transaction } from "@/server/db";
import { NotFoundError } from "@/server/errors";
import { parseQuantity, type Milli } from "@/shared/quantity";
import { productUnits, products, units } from "./schema";

/** What the pricing module needs to know about a product. Callers check permissions first. */
export type ProductPricingInputs = {
  id: string;
  name: string;
  sku: string;
  isActive: boolean;
  baseUnit: string;
  baseUnitName: string;
  baseAllowsDecimal: boolean;
  retailPaise: number;
  wholesalePaise: number;
  /** Always loaded here; the pricing module decides who may see it. */
  costPaise: number | null;
  /** Active sale units other than the base unit, with their per-product factor. */
  saleUnits: { code: string; name: string; factor: Milli }[];
};

/**
 * Loads one product of `shopId` with its active pack sizes. Unknown ids and ids of another shop
 * are "not found". No permission check: the calling service has already done it.
 */
export async function loadProductPricingInputs(shopId: string, productId: string, db: Database | Transaction = getDb()): Promise<ProductPricingInputs> {
  if (!/^[0-9a-f-]{36}$/i.test(productId)) throw new NotFoundError("Product not found.");
  const [product] = await db
    .select({
      id: products.id,
      name: products.name,
      sku: products.sku,
      isActive: products.isActive,
      baseUnit: products.baseUnit,
      baseUnitName: units.name,
      baseAllowsDecimal: units.allowDecimal,
      retailPaise: products.retailPaise,
      wholesalePaise: products.wholesalePaise,
      costPaise: products.costPaise,
    })
    .from(products)
    .innerJoin(units, and(eq(units.shopId, products.shopId), eq(units.code, products.baseUnit)))
    .where(and(eq(products.id, productId), eq(products.shopId, shopId)))
    .limit(1);
  if (!product) throw new NotFoundError("Product not found.");

  const packs = await db
    .select({ code: productUnits.unit, name: units.name, factor: productUnits.factor })
    .from(productUnits)
    .innerJoin(units, and(eq(units.shopId, shopId), eq(units.code, productUnits.unit)))
    .where(and(eq(productUnits.productId, productId), eq(productUnits.isActive, true), eq(units.isActive, true)));
  return { ...product, saleUnits: packs.map((pack) => ({ code: pack.code, name: pack.name, factor: parseQuantity(pack.factor) })) };
}

/** Names of products of `shopId`, for labelling rules. Ids of other shops are ignored. */
export async function loadProductNames(shopId: string, productIds: string[], db: Database | Transaction = getDb()): Promise<Map<string, { name: string; baseUnit: string }>> {
  if (productIds.length === 0) return new Map();
  const rows = await db
    .select({ id: products.id, name: products.name, baseUnit: products.baseUnit })
    .from(products)
    .where(and(eq(products.shopId, shopId), inArray(products.id, productIds)));
  return new Map(rows.map((row) => [row.id, { name: row.name, baseUnit: row.baseUnit }]));
}
