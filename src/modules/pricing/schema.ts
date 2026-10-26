import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { products } from "../catalog/schema";
import { customers } from "../parties/schema";
import { shops } from "../settings/schema";
import { createdAt, id, oneOf, paise, quantity } from "../../server/schema-helpers";

/** Owned by the pricing module: wholesale quantity slabs and customer-specific rules. */

export const priceSlabs = pgTable(
  "price_slabs",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    productId: uuid("product_id").notNull().references(() => products.id),
    minQty: quantity("min_qty").notNull(), // base units
    pricePaise: paise("price_paise").notNull(), // per base unit
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    // One active slab per minimum quantity; retired slabs stay on record.
    uniqueIndex("price_slabs_active_min_qty_key").on(t.productId, t.minQty).where(sql`${t.isActive}`),
    index("price_slabs_shop_product_idx").on(t.shopId, t.productId),
    check("price_slabs_min_qty_check", sql`${t.minQty} > 1`),
    check("price_slabs_price_check", sql`${t.pricePaise} > 0`),
  ],
);

export const PRICE_RULE_KINDS = ["pct", "fixed"] as const;

export const customerPriceRules = pgTable(
  "customer_price_rules",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    customerId: uuid("customer_id").notNull().references(() => customers.id),
    productId: uuid("product_id").references(() => products.id), // NULL = all products
    kind: text("kind").$type<(typeof PRICE_RULE_KINDS)[number]>().notNull(),
    value: integer("value").notNull(), // pct: basis points (100 = 1%); fixed: paise
    minQty: quantity("min_qty").notNull().default("0"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    index("customer_price_rules_customer_idx").on(t.customerId).where(sql`${t.isActive}`),
    check("customer_price_rules_kind_check", oneOf(t.kind, PRICE_RULE_KINDS)),
    check("customer_price_rules_value_check", sql`${t.value} > 0`),
    check("customer_price_rules_pct_range_check", sql`${t.kind} <> 'pct' or ${t.value} between 10 and 3000`), // 0.1%–30%
    check("customer_price_rules_fixed_product_check", sql`${t.kind} <> 'fixed' or ${t.productId} is not null`),
    check("customer_price_rules_min_qty_check", sql`${t.minQty} >= 0`),
    // At most one active rule of each kind per scope, so the price never depends on row order.
    uniqueIndex("customer_price_rules_active_fixed_key").on(t.customerId, t.productId, t.minQty).where(sql`${t.isActive} and ${t.kind} = 'fixed'`),
    uniqueIndex("customer_price_rules_active_pct_product_key").on(t.customerId, t.productId).where(sql`${t.isActive} and ${t.kind} = 'pct' and ${t.productId} is not null`),
    uniqueIndex("customer_price_rules_active_pct_all_key").on(t.customerId).where(sql`${t.isActive} and ${t.kind} = 'pct' and ${t.productId} is null`),
  ],
);
