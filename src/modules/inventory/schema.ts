import { sql } from "drizzle-orm";
import { bigint, char, check, date, index, pgTable, text, timestamp, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { products } from "../catalog/schema";
import { approvals, users } from "../identity/schema";
import { shops } from "../settings/schema";
import { createdAt, id, oneOf, paise, quantity } from "../../server/schema-helpers";

/**
 * Owned by the inventory module.
 * stock_movements is the SOURCE OF TRUTH for stock and is append-only (trigger in migration 0002).
 * stock_levels is a cache written in the same transaction and reconciled against v_stock.
 */

export const STOCK_MOVEMENT_KINDS = [
  "opening",
  "sale",
  "sale_cancel",
  "return_in",
  "purchase",
  "return_out",
  "damage",
  "count",
] as const;

export const stockMovements = pgTable(
  "stock_movements",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    productId: uuid("product_id").notNull().references(() => products.id),
    movementDate: date("movement_date", { mode: "string" }).notNull(),
    kind: text("kind").$type<(typeof STOCK_MOVEMENT_KINDS)[number]>().notNull(),
    qtyBase: quantity("qty_base").notNull(), // + in, − out
    unitCostPaise: paise("unit_cost_paise"),
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    reason: text("reason"),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("stock_movements_product_idx").on(t.productId, t.id),
    // The same source document can never move the same product twice for the same reason.
    uniqueIndex("stock_movements_source_key").on(t.sourceType, t.sourceId, t.productId, t.kind),
    check("stock_movements_kind_check", oneOf(t.kind, STOCK_MOVEMENT_KINDS)),
    check("stock_movements_qty_check", sql`${t.qtyBase} <> 0`),
  ],
);

/** Cache only. Rebuilt from stock_movements; locked FOR UPDATE by billing to serialise sales. */
export const stockLevels = pgTable("stock_levels", {
  productId: uuid("product_id")
    .primaryKey()
    .references(() => products.id),
  shopId: uuid("shop_id").notNull(),
  qtyBase: quantity("qty_base").notNull(),
  lastMovementId: bigint("last_movement_id", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
});

export const STOCK_ADJUSTMENT_KINDS = ["return_in", "damage", "count"] as const;

export const stockAdjustments = pgTable(
  "stock_adjustments",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    fy: char("fy", { length: 5 }).notNull(),
    number: varchar("number", { length: 16 }).notNull(),
    kind: text("kind").$type<(typeof STOCK_ADJUSTMENT_KINDS)[number]>().notNull(),
    reason: text("reason").notNull(),
    approvalId: uuid("approval_id").references(() => approvals.id),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    // Added for consistency with every other numbered document (not listed in the architecture DDL).
    unique("stock_adjustments_shop_fy_number_key").on(t.shopId, t.fy, t.number),
    check("stock_adjustments_kind_check", oneOf(t.kind, STOCK_ADJUSTMENT_KINDS)),
  ],
);
