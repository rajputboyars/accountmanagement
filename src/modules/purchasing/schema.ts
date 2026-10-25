import { sql } from "drizzle-orm";
import { char, check, date, numeric, pgTable, text, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { products } from "../catalog/schema";
import { users } from "../identity/schema";
import { suppliers } from "../parties/schema";
import { shops } from "../settings/schema";
import { createdAt, id, oneOf, paise, quantity } from "../../server/schema-helpers";

/** Owned by the purchasing module: purchase orders and goods receipts. */

export const PURCHASE_ORDER_STATUSES = ["ordered", "partially_received", "received", "closed", "cancelled"] as const;

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    fy: char("fy", { length: 5 }).notNull(),
    number: varchar("number", { length: 16 }).notNull(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id),
    orderDate: date("order_date", { mode: "string" }).notNull(),
    status: text("status").$type<(typeof PURCHASE_ORDER_STATUSES)[number]>().notNull(),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("purchase_orders_shop_fy_number_key").on(t.shopId, t.fy, t.number),
    check("purchase_orders_status_check", oneOf(t.status, PURCHASE_ORDER_STATUSES)),
  ],
);

export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: id(),
    purchaseOrderId: uuid("purchase_order_id").notNull().references(() => purchaseOrders.id),
    productId: uuid("product_id").notNull().references(() => products.id),
    unit: text("unit").notNull(),
    factor: numeric("factor", { precision: 12, scale: 3 }).notNull().default("1"),
    qtyOrdered: quantity("qty_ordered").notNull(),
    costPaisePerUnit: paise("cost_paise_per_unit").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("purchase_order_lines_qty_check", sql`${t.qtyOrdered} > 0`),
    check("purchase_order_lines_cost_check", sql`${t.costPaisePerUnit} > 0`),
  ],
);

export const goodsReceipts = pgTable(
  "goods_receipts",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    fy: char("fy", { length: 5 }).notNull(),
    number: varchar("number", { length: 16 }).notNull(),
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrders.id),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id),
    supplierBillNo: varchar("supplier_bill_no", { length: 30 }),
    supplierBillDate: date("supplier_bill_date", { mode: "string" }),
    receivedDate: date("received_date", { mode: "string" }).notNull(),
    taxablePaise: paise("taxable_paise").notNull(),
    gstPaise: paise("gst_paise").notNull().default(0),
    totalPaise: paise("total_paise").notNull(),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("goods_receipts_shop_fy_number_key").on(t.shopId, t.fy, t.number),
    uniqueIndex("goods_receipts_supplier_bill_key")
      .on(t.supplierId, t.supplierBillNo)
      .where(sql`${t.supplierBillNo} is not null`),
  ],
);

export const goodsReceiptLines = pgTable(
  "goods_receipt_lines",
  {
    id: id(),
    goodsReceiptId: uuid("goods_receipt_id").notNull().references(() => goodsReceipts.id),
    purchaseOrderLineId: uuid("purchase_order_line_id").references(() => purchaseOrderLines.id),
    productId: uuid("product_id").notNull().references(() => products.id),
    qtyBase: quantity("qty_base").notNull(),
    unitCostPaise: paise("unit_cost_paise").notNull(),
    linePaise: paise("line_paise").notNull(),
    createdAt: createdAt(),
  },
  (t) => [check("goods_receipt_lines_qty_check", sql`${t.qtyBase} > 0`)],
);
