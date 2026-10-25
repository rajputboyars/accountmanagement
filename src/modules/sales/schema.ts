import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  date,
  index,
  integer,
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
import { customers } from "../parties/schema";
import { devices, shops } from "../settings/schema";
import { createdAt, oneOf, paise, quantity } from "../../server/schema-helpers";

/**
 * Owned by the sales module: invoices, their lines, and credit notes.
 * Invoice IDs may be generated on the counter device (UUID v7), so the column has no default.
 */

export const INVOICE_STATUSES = ["issued", "cancelled"] as const;
export const PRICE_LISTS = ["retail", "wholesale"] as const;
export const CREDIT_NOTE_SETTLEMENTS = ["ledger", "cash", "upi", "bank"] as const;

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
    taxablePaise: paise("taxable_paise").notNull(),
    cgstPaise: paise("cgst_paise").notNull(),
    sgstPaise: paise("sgst_paise").notNull(),
    igstPaise: paise("igst_paise").notNull().default(0),
    roundOffPaise: integer("round_off_paise").notNull(),
    totalPaise: paise("total_paise").notNull(),
    paidNowPaise: paise("paid_now_paise").notNull().default(0),
    costComplete: boolean("cost_complete").notNull(), // false if any line has no cost: profit not shown
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
    lineDiscountPaise: paise("line_discount_paise").notNull().default(0),
    taxablePaise: paise("taxable_paise").notNull(),
    gstRateBp: integer("gst_rate_bp").notNull(),
    cgstPaise: paise("cgst_paise").notNull(),
    sgstPaise: paise("sgst_paise").notNull(),
    unitCostPaise: paise("unit_cost_paise"), // per base unit at sale; NULL = unknown
    createdAt: createdAt(),
  },
  (t) => [
    unique("invoice_lines_invoice_line_no_key").on(t.invoiceId, t.lineNo),
    index("invoice_lines_product_idx").on(t.productId),
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
    settlement: text("settlement").$type<(typeof CREDIT_NOTE_SETTLEMENTS)[number]>().notNull(),
    taxablePaise: paise("taxable_paise").notNull(),
    cgstPaise: paise("cgst_paise").notNull(),
    sgstPaise: paise("sgst_paise").notNull(),
    roundOffPaise: integer("round_off_paise").notNull(),
    totalPaise: paise("total_paise").notNull(),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("credit_notes_shop_fy_number_key").on(t.shopId, t.fy, t.number),
    check("credit_notes_settlement_check", oneOf(t.settlement, CREDIT_NOTE_SETTLEMENTS)),
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
    restock: boolean("restock").notNull(), // false = goes to damaged
    createdAt: createdAt(),
  },
  (t) => [check("credit_note_lines_base_qty_check", sql`${t.baseQty} > 0`)],
);
