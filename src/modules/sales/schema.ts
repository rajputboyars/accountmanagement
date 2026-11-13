import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { products } from "../catalog/schema";
import { approvals, users } from "../identity/schema";
import { godowns } from "../inventory/schema";
import { customers } from "../parties/schema";
import { devices, shops } from "../settings/schema";
import { createdAt, oneOf, paise, quantity } from "../../server/schema-helpers";

/** Seller details printed on a bill or credit note, frozen when it is issued. */
export type DocumentSeller = { name: string; legalName: string | null; address: string | null; pinCode: string | null; phone: string | null; email: string | null; gstin: string | null; stateCode: string; registration: string };
/** Buyer details printed on a bill or credit note, frozen when it is issued. */
export type DocumentBuyer = { name: string; phone: string | null; gstin: string | null; area: string | null };

/**
 * Owned by the sales module: invoices, their lines, and credit notes.
 * Invoice IDs may be generated on the counter device (UUID v7), so the column has no default.
 */

export const INVOICE_STATUSES = ["issued", "cancelled"] as const;
export const PRICE_LISTS = ["retail", "wholesale"] as const;
export const CREDIT_NOTE_SETTLEMENTS = ["ledger", "cash", "upi", "bank"] as const;
export const TAX_MODES = ["intra", "inter", "none"] as const;

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    fy: char("fy", { length: 5 }).notNull(),
    number: varchar("number", { length: 16 }).notNull(), // INV/26-27/00483
    businessDate: date("business_date", { mode: "string" }).notNull(),
    customerId: uuid("customer_id").notNull().references(() => customers.id),
    priceList: text("price_list").$type<(typeof PRICE_LISTS)[number]>().notNull(),
    deviceId: uuid("device_id").references(() => devices.id),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    status: text("status").$type<(typeof INVOICE_STATUSES)[number]>().notNull().default("issued"),
    subtotalPaise: paise("subtotal_paise").notNull(),
    discountBp: integer("discount_bp").notNull().default(0),
    discountPaise: paise("discount_paise").notNull().default(0),
    itemDiscountPaise: paise("item_discount_paise").notNull().default(0), // Σ the lines' own discounts; the bill discount above comes after
    taxablePaise: paise("taxable_paise").notNull(),
    cgstPaise: paise("cgst_paise").notNull(),
    sgstPaise: paise("sgst_paise").notNull(),
    igstPaise: paise("igst_paise").notNull().default(0),
    roundOffPaise: integer("round_off_paise").notNull(),
    totalPaise: paise("total_paise").notNull(),
    paidNowPaise: paise("paid_now_paise").notNull().default(0),
    costComplete: boolean("cost_complete").notNull(), // false if any line has no cost: profit not shown
    /** Billed from delivered goods (challans): stock left at delivery, so this bill never moves stock. */
    fromChallans: boolean("from_challans").notNull().default(false),
    taxMode: text("tax_mode").$type<(typeof TAX_MODES)[number]>().notNull().default("intra"), // src/shared/gst.ts
    placeOfSupply: char("place_of_supply", { length: 2 }), // GST state code; NULL on bills before Phase 15 = shop's state
    // Seller and buyer as they were when the bill was issued, so a later change to the shop's GSTIN,
    // address or the customer's details never alters an issued bill. NULL on older bills (shown live).
    seller: jsonb("seller").$type<DocumentSeller>(),
    buyer: jsonb("buyer").$type<DocumentBuyer>(),
    discountApprovalId: uuid("discount_approval_id").references(() => approvals.id),
    correctsInvoiceId: uuid("corrects_invoice_id").references((): AnyPgColumn => invoices.id),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by").references(() => users.id),
    cancelReason: text("cancel_reason"),
    clientCreatedAt: timestamp("client_created_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("invoices_shop_fy_number_key").on(t.shopId, t.fy, t.number),
    index("invoices_shop_business_date_idx").on(t.shopId, t.businessDate),
    index("invoices_customer_business_date_idx").on(t.customerId, t.businessDate),
    check("invoices_status_check", oneOf(t.status, INVOICE_STATUSES)),
    check("invoices_tax_mode_check", oneOf(t.taxMode, TAX_MODES)),
    check("invoices_tax_mode_amounts_check", sql`(${t.taxMode} = 'intra' and ${t.igstPaise} = 0) or (${t.taxMode} = 'inter' and ${t.cgstPaise} = 0 and ${t.sgstPaise} = 0) or (${t.taxMode} = 'none' and ${t.cgstPaise} = 0 and ${t.sgstPaise} = 0 and ${t.igstPaise} = 0)`),
    check("invoices_price_list_check", oneOf(t.priceList, PRICE_LISTS)),
    check("invoices_round_off_check", sql`${t.roundOffPaise} between -50 and 50`),
    check("invoices_paid_now_check", sql`${t.paidNowPaise} between 0 and ${t.totalPaise}`),
    check(
      "invoices_total_check",
      sql`${t.totalPaise} = ${t.taxablePaise} + ${t.cgstPaise} + ${t.sgstPaise} + ${t.igstPaise} + ${t.roundOffPaise}`,
    ),
  ],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: uuid("id").primaryKey(),
    invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
    lineNo: smallint("line_no").notNull(),
    productId: uuid("product_id").notNull().references(() => products.id),
    unit: text("unit").notNull(),
    factor: numeric("factor", { precision: 12, scale: 3 }).notNull().default("1"),
    qty: quantity("qty").notNull(),
    baseQty: quantity("base_qty").notNull(),
    ratePaise: paise("rate_paise").notNull(),
    rateReason: text("rate_reason").notNull(), // 'Slab 50+ −1%'
    linePaise: paise("line_paise").notNull(),
    lineDiscountPaise: paise("line_discount_paise").notNull().default(0), // this line's share of the bill discount
    // The line's own discount as it was entered and worked out: a snapshot, never recomputed from today's prices.
    discountKind: text("discount_kind").notNull().default("none"), // none | flat | percent
    discountValue: bigint("discount_value", { mode: "number" }).notNull().default(0), // flat: paise · percent: basis points
    itemDiscountPaise: paise("item_discount_paise").notNull().default(0),
    taxablePaise: paise("taxable_paise").notNull(),
    gstRateBp: integer("gst_rate_bp").notNull(),
    cgstPaise: paise("cgst_paise").notNull(),
    sgstPaise: paise("sgst_paise").notNull(),
    igstPaise: paise("igst_paise").notNull().default(0),
    unitCostPaise: paise("unit_cost_paise"), // per base unit at sale; NULL = unknown
    productName: text("product_name"), // as billed; NULL on older bills (shown from the product)
    hsn: varchar("hsn", { length: 8 }), // as billed; NULL on older bills
    createdAt: createdAt(),
  },
  (t) => [
    unique("invoice_lines_invoice_line_no_key").on(t.invoiceId, t.lineNo),
    index("invoice_lines_product_idx").on(t.productId),
    check("invoice_lines_discount_kind_check", sql`${t.discountKind} in ('none', 'flat', 'percent')`),
    check("invoice_lines_item_discount_check", sql`${t.itemDiscountPaise} between 0 and ${t.linePaise}`),
    check("invoice_lines_qty_check", sql`${t.qty} > 0`),
    check("invoice_lines_base_qty_check", sql`${t.baseQty} > 0`),
  ],
);

export const creditNotes = pgTable(
  "credit_notes",
  {
    id: uuid("id").primaryKey(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    fy: char("fy", { length: 5 }).notNull(),
    number: varchar("number", { length: 16 }).notNull(),
    invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
    customerId: uuid("customer_id").notNull().references(() => customers.id),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    reason: text("reason").notNull(),
    seller: jsonb("seller").$type<DocumentSeller>(), // as at the credit note; NULL on older notes
    buyer: jsonb("buyer").$type<DocumentBuyer>(),
    settlement: text("settlement").$type<(typeof CREDIT_NOTE_SETTLEMENTS)[number]>().notNull(),
    taxablePaise: paise("taxable_paise").notNull(),
    cgstPaise: paise("cgst_paise").notNull(),
    sgstPaise: paise("sgst_paise").notNull(),
    igstPaise: paise("igst_paise").notNull().default(0),
    roundOffPaise: integer("round_off_paise").notNull(),
    totalPaise: paise("total_paise").notNull(),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("credit_notes_shop_fy_number_key").on(t.shopId, t.fy, t.number),
    check("credit_notes_settlement_check", oneOf(t.settlement, CREDIT_NOTE_SETTLEMENTS)),
    index("credit_notes_invoice_idx").on(t.invoiceId),
    check("credit_notes_round_off_check", sql`${t.roundOffPaise} between -50 and 50`),
    check("credit_notes_total_check", sql`${t.totalPaise} = ${t.taxablePaise} + ${t.cgstPaise} + ${t.sgstPaise} + ${t.igstPaise} + ${t.roundOffPaise}`),
    check("credit_notes_amounts_check", sql`${t.taxablePaise} >= 0 and ${t.cgstPaise} >= 0 and ${t.sgstPaise} >= 0 and ${t.igstPaise} >= 0 and ${t.totalPaise} >= 0`),
  ],
);

export const creditNoteLines = pgTable(
  "credit_note_lines",
  {
    id: uuid("id").primaryKey(),
    creditNoteId: uuid("credit_note_id").notNull().references(() => creditNotes.id),
    invoiceLineId: uuid("invoice_line_id").notNull().references(() => invoiceLines.id),
    baseQty: quantity("base_qty").notNull(),
    taxablePaise: paise("taxable_paise").notNull(),
    cgstPaise: paise("cgst_paise").notNull(),
    sgstPaise: paise("sgst_paise").notNull(),
    igstPaise: paise("igst_paise").notNull().default(0),
    restock: boolean("restock").notNull(), // false = goes to damaged
    createdAt: createdAt(),
  },
  (t) => [
    check("credit_note_lines_base_qty_check", sql`${t.baseQty} > 0`),
    // One line per invoice line per credit note; remaining quantities are summed per invoice line.
    unique("credit_note_lines_note_line_key").on(t.creditNoteId, t.invoiceLineId),
    index("credit_note_lines_invoice_line_idx").on(t.invoiceLineId),
    check("credit_note_lines_amounts_check", sql`${t.taxablePaise} >= 0 and ${t.cgstPaise} >= 0 and ${t.sgstPaise} >= 0`),
  ],
);

export const SALES_ORDER_STATUSES = ["draft", "confirmed", "partially_delivered", "delivered", "cancelled"] as const;
export const CHALLAN_STATUSES = ["delivered", "cancelled"] as const;

/** An optional order from a customer. It reserves stock when confirmed but never moves it; delivery challans do that. */
export const salesOrders = pgTable(
  "sales_orders",
  {
    id: uuid("id").primaryKey(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    fy: char("fy", { length: 5 }).notNull(),
    number: varchar("number", { length: 16 }).notNull(),
    customerId: uuid("customer_id").notNull().references(() => customers.id),
    status: text("status").$type<(typeof SALES_ORDER_STATUSES)[number]>().notNull().default("draft"),
    orderDate: date("order_date", { mode: "string" }).notNull(),
    expectedDate: date("expected_date", { mode: "string" }),
    notes: text("notes"),
    /** Where stock is reserved; chosen at confirmation when the shop has several godowns. */
    godownId: uuid("godown_id").references(() => godowns.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    /** Set when the order is closed after a partial delivery: what was not delivered is dropped and its reservation released. */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("sales_orders_shop_fy_number_key").on(t.shopId, t.fy, t.number),
    index("sales_orders_shop_status_idx").on(t.shopId, t.status),
    index("sales_orders_customer_idx").on(t.customerId),
    check("sales_orders_status_check", oneOf(t.status, SALES_ORDER_STATUSES)),
  ],
);

export const salesOrderLines = pgTable(
  "sales_order_lines",
  {
    id: uuid("id").primaryKey(),
    orderId: uuid("order_id").notNull().references(() => salesOrders.id),
    lineNo: smallint("line_no").notNull(),
    productId: uuid("product_id").notNull().references(() => products.id),
    /** As ordered: unit, the product's factor then, quantity in that unit and the base quantity. */
    unit: text("unit").notNull(),
    factor: numeric("factor", { precision: 12, scale: 3 }).notNull(),
    qty: quantity("qty").notNull(),
    baseQty: quantity("base_qty").notNull(),
    /** What the price looked like when the order was taken, per ordered unit. Indicative only: the bill is always priced afresh. */
    indicativeRatePaise: paise("indicative_rate_paise").notNull(),
    productName: text("product_name").notNull(),
  },
  (t) => [unique("sales_order_lines_no_key").on(t.orderId, t.lineNo), check("sales_order_lines_qty_check", sql`${t.baseQty} > 0 and ${t.qty} > 0`)],
);

/** Goods that left the shop against an order. This is where physical stock is deducted, once. */
export const deliveryChallans = pgTable(
  "delivery_challans",
  {
    id: uuid("id").primaryKey(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    fy: char("fy", { length: 5 }).notNull(),
    number: varchar("number", { length: 16 }).notNull(),
    orderId: uuid("order_id").notNull().references(() => salesOrders.id),
    customerId: uuid("customer_id").notNull().references(() => customers.id),
    godownId: uuid("godown_id").notNull().references(() => godowns.id),
    deliveryDate: date("delivery_date", { mode: "string" }).notNull(),
    note: text("note"),
    status: text("status").$type<(typeof CHALLAN_STATUSES)[number]>().notNull().default("delivered"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("delivery_challans_shop_fy_number_key").on(t.shopId, t.fy, t.number),
    index("delivery_challans_order_idx").on(t.orderId),
    check("delivery_challans_status_check", oneOf(t.status, CHALLAN_STATUSES)),
  ],
);

export const deliveryChallanLines = pgTable(
  "delivery_challan_lines",
  {
    id: uuid("id").primaryKey(),
    challanId: uuid("challan_id").notNull().references(() => deliveryChallans.id),
    orderLineId: uuid("order_line_id").notNull().references(() => salesOrderLines.id),
    productId: uuid("product_id").notNull().references(() => products.id),
    unit: text("unit").notNull(),
    factor: numeric("factor", { precision: 12, scale: 3 }).notNull(),
    qty: quantity("qty").notNull(),
    baseQty: quantity("base_qty").notNull(),
    /** The cost per base unit when it left; the bill's profit uses this, not today's cost. Null = unknown. */
    unitCostPaise: paise("unit_cost_paise"),
    productName: text("product_name").notNull(),
  },
  (t) => [unique("delivery_challan_lines_key").on(t.challanId, t.orderLineId), index("delivery_challan_lines_order_line_idx").on(t.orderLineId), check("delivery_challan_lines_qty_check", sql`${t.baseQty} > 0 and ${t.qty} > 0`)],
);

/** Which delivered quantity each bill line covers. Cancelling the bill releases its links so the goods can be billed again. */
export const invoiceChallanLinks = pgTable(
  "invoice_challan_links",
  {
    id: uuid("id").primaryKey(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
    invoiceLineId: uuid("invoice_line_id").notNull().references(() => invoiceLines.id),
    challanLineId: uuid("challan_line_id").notNull().references(() => deliveryChallanLines.id),
    baseQty: quantity("base_qty").notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("invoice_challan_links_challan_line_idx").on(t.challanLineId), index("invoice_challan_links_invoice_idx").on(t.invoiceId), check("invoice_challan_links_qty_check", sql`${t.baseQty} > 0`)],
);
