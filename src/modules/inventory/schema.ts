import { sql } from "drizzle-orm";
import { bigint, boolean, char, check, date, index, numeric, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
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
  "transfer_in",
  "transfer_out",
] as const;

/**
 * A place stock is kept. Every shop has one default "Main Store", created silently; more can be added by the owner.
 * A godown is never deleted: switching it off keeps every movement that mentions it. Stock is per product and godown.
 */
export const godowns = pgTable(
  "godowns",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    name: varchar("name", { length: 60 }).notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("godowns_one_default_key").on(t.shopId).where(sql`${t.isDefault}`),
    uniqueIndex("godowns_shop_name_key").on(t.shopId, sql`lower(${t.name})`),
    check("godowns_default_active_check", sql`not ${t.isDefault} or ${t.isActive}`),
  ],
);

export const stockMovements = pgTable(
  "stock_movements",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    productId: uuid("product_id").notNull().references(() => products.id),
    godownId: uuid("godown_id").notNull().references(() => godowns.id),
    movementDate: date("movement_date", { mode: "string" }).notNull(),
    kind: text("kind").$type<(typeof STOCK_MOVEMENT_KINDS)[number]>().notNull(),
    qtyBase: quantity("qty_base").notNull(), // + in, − out
    unitCostPaise: paise("unit_cost_paise"),
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    reason: text("reason"),
    /** As entered, for movements recorded after unit snapshots began; null for older history (never reconstructed). */
    enteredQty: numeric("entered_qty", { precision: 14, scale: 3 }),
    enteredUnit: text("entered_unit"),
    enteredFactor: numeric("entered_factor", { precision: 12, scale: 3 }),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("stock_movements_godown_product_idx").on(t.godownId, t.productId, t.id),
    index("stock_movements_product_idx").on(t.productId, t.id),
    // The same source document can never move the same product twice for the same reason.
    uniqueIndex("stock_movements_source_key").on(t.sourceType, t.sourceId, t.productId, t.kind),
    // Opening stock is entered once per product and godown (spec §8); later changes are adjustments.
    uniqueIndex("stock_movements_one_opening_key").on(t.productId, t.godownId).where(sql`${t.kind} = 'opening'`),
    check("stock_movements_kind_check", oneOf(t.kind, STOCK_MOVEMENT_KINDS)),
    check("stock_movements_qty_check", sql`${t.qtyBase} <> 0`),
  ],
);

/** Cache only. Rebuilt from stock_movements; locked FOR UPDATE by billing to serialise sales. */
export const stockLevels = pgTable(
  "stock_levels",
  {
    productId: uuid("product_id").notNull().references(() => products.id),
    godownId: uuid("godown_id").notNull().references(() => godowns.id),
    shopId: uuid("shop_id").notNull(),
    qtyBase: quantity("qty_base").notNull(),
    lastMovementId: bigint("last_movement_id", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.productId, t.godownId] })],
);

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

/**
 * Stock moved between two godowns of one shop. The two legs are ordinary movements (transfer_out and transfer_in, same source
 * and product, opposite signs, same cost), so shop-wide stock, stock value and profit do not change and no journal is posted.
 */
export const stockTransfers = pgTable(
  "stock_transfers",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    fy: char("fy", { length: 5 }).notNull(),
    number: varchar("number", { length: 16 }).notNull(),
    fromGodownId: uuid("from_godown_id").notNull().references(() => godowns.id),
    toGodownId: uuid("to_godown_id").notNull().references(() => godowns.id),
    transferDate: date("transfer_date", { mode: "string" }).notNull(),
    reason: text("reason"),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("stock_transfers_shop_fy_number_key").on(t.shopId, t.fy, t.number),
    index("stock_transfers_shop_date_idx").on(t.shopId, t.transferDate),
    check("stock_transfers_distinct_check", sql`${t.fromGodownId} <> ${t.toGodownId}`),
  ],
);

export const stockTransferLines = pgTable(
  "stock_transfer_lines",
  {
    id: id(),
    transferId: uuid("transfer_id").notNull().references(() => stockTransfers.id),
    productId: uuid("product_id").notNull().references(() => products.id),
    /** As entered: quantity in this unit, the product's factor for it then, and the base quantity moved. */
    unit: text("unit").notNull(),
    factor: numeric("factor", { precision: 12, scale: 3 }).notNull(),
    qty: numeric("qty", { precision: 14, scale: 3 }).notNull(),
    baseQty: quantity("base_qty").notNull(),
    unitCostPaise: paise("unit_cost_paise"),
  },
  (t) => [unique("stock_transfer_lines_product_key").on(t.transferId, t.productId), check("stock_transfer_lines_qty_check", sql`${t.baseQty} > 0 and ${t.qty} > 0`)],
);
