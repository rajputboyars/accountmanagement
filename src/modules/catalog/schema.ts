import { sql } from "drizzle-orm";
import { boolean, check, index, integer, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { shops } from "../settings/schema";
import { createdAt, id, paise, quantity } from "../../server/schema-helpers";

/** Owned by the catalog module: categories, products, units and cost history. */

export const GST_RATES_BP = [0, 500, 1200, 1800, 2800] as const;

export const categories = pgTable(
  "categories",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("categories_shop_name_key").on(t.shopId, t.name)],
);

export const products = pgTable(
  "products",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    sku: varchar("sku", { length: 30 }).notNull(),
    barcode: varchar("barcode", { length: 30 }),
    name: varchar("name", { length: 120 }).notNull(),
    categoryId: uuid("category_id").references(() => categories.id),
    baseUnit: text("base_unit").notNull(), // 'pc','kg','m','ltr','bag','box'
    hsn: varchar("hsn", { length: 8 }).notNull(),
    gstRateBp: integer("gst_rate_bp").notNull(),
    costPaise: paise("cost_paise"), // per base unit; NULL = cost unknown (profit not shown)
    retailPaise: paise("retail_paise").notNull(),
    wholesalePaise: paise("wholesale_paise").notNull(),
    reorderLevel: quantity("reorder_level").notNull().default("10"),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    unique("products_shop_sku_key").on(t.shopId, t.sku),
    uniqueIndex("products_shop_barcode_key").on(t.shopId, t.barcode).where(sql`${t.barcode} is not null`),
    index("products_name_trgm").using("gin", t.name.op("gin_trgm_ops")),
    check("products_gst_rate_check", sql`${t.gstRateBp} in (0, 500, 1200, 1800, 2800)`),
    check("products_cost_check", sql`${t.costPaise} >= 0`),
    check("products_retail_check", sql`${t.retailPaise} > 0`),
    check("products_wholesale_check", sql`${t.wholesalePaise} > 0`),
  ],
);

/** Extra sale/purchase units: box = 50 pc. Stock is always kept in the product's base unit. */
export const productUnits = pgTable(
  "product_units",
  {
    id: id(),
    productId: uuid("product_id").notNull().references(() => products.id),
    unit: text("unit").notNull(),
    factor: numeric("factor", { precision: 12, scale: 3 }).notNull(),
    retailPaise: paise("retail_paise"),
    wholesalePaise: paise("wholesale_paise"),
    barcode: varchar("barcode", { length: 30 }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("product_units_product_unit_key").on(t.productId, t.unit),
    check("product_units_factor_check", sql`${t.factor} > 0`),
  ],
);

export const productCostHistory = pgTable("product_cost_history", {
  id: id(),
  productId: uuid("product_id").notNull().references(() => products.id),
  costPaise: paise("cost_paise").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: uuid("source_id"),
  effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});
