import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { shops } from "../settings/schema";
import { createdAt, id, paise, quantity } from "../../server/schema-helpers";

/** Owned by the catalog module: categories, products, units and cost history. */

export const GST_RATES_BP = [0, 500, 1200, 1800, 2800] as const;

/**
 * Units a shop sells or counts in (Piece, Box, Meter …). Products reference a unit by its short
 * code. allow_decimal says whether fractional quantities make sense (2.5 m yes, 2.5 pieces no).
 * There are no global conversions: how many pieces are in a box is set per product (product_units).
 */
export const units = pgTable(
  "units",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    code: varchar("code", { length: 16 }).notNull(),
    name: varchar("name", { length: 40 }).notNull(),
    allowDecimal: boolean("allow_decimal").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique("units_shop_code_key").on(t.shopId, t.code),
    check("units_code_check", sql`${t.code} ~ '^[a-z][a-z0-9]{0,15}$'`),
  ],
);

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
    description: varchar("description", { length: 500 }),
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
    check("products_gst_rate_check", sql`${t.gstRateBp} in (0, 10, 25, 150, 300, 500, 1200, 1800, 2800, 4000)`), // STATUTORY_GST_RATES_BP
    check("products_cost_check", sql`${t.costPaise} >= 0`),
    check("products_retail_check", sql`${t.retailPaise} > 0`),
    check("products_wholesale_check", sql`${t.wholesalePaise} > 0`),
    // The base unit must be one of this shop's units.
    foreignKey({ name: "products_base_unit_fkey", columns: [t.shopId, t.baseUnit], foreignColumns: [units.shopId, units.code] }),
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
    // Retired conversions stay for history; a unit is never deleted once it may be on a bill.
    isActive: boolean("is_active").notNull().default(true),
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
