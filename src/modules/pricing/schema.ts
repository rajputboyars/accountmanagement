import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { products } from "../catalog/schema";
import { customers } from "../parties/schema";
import { shops } from "../settings/schema";
import { createdAt, id, oneOf, paise, quantity } from "../../server/schema-helpers";

/** Owned by the pricing module: wholesale quantity slabs and customer-specific rules. */

export const priceSlabs = pgTable(
  "price_slabs",
  {
    id: id(),
    productId: uuid("product_id").notNull().references(() => products.id),
    minQty: quantity("min_qty").notNull(), // base units
    pricePaise: paise("price_paise").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("price_slabs_product_min_qty_key").on(t.productId, t.minQty),
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
  ],
);
