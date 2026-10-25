import { sql } from "drizzle-orm";
import { char, check, date, index, pgTable, text, uniqueIndex, uuid, varchar, type AnyPgColumn } from "drizzle-orm/pg-core";
import { users } from "../identity/schema";
import { creditNotes, invoices } from "../sales/schema";
import { devices, shops } from "../settings/schema";
import { createdAt, oneOf, paise } from "../../server/schema-helpers";

/**
 * Owned by the payments module: money in (customer receipts, counter payments) and money out
 * (refunds, supplier payments). One row per method in a split payment. A reversal is a new
 * payment row linked from the original; amounts are never edited.
 */

export const PAYMENT_DIRECTIONS = ["in", "out"] as const;
export const PAYMENT_PARTY_TYPES = ["customer", "supplier", "none"] as const;
export const PAYMENT_METHODS = ["cash", "upi", "card", "bank", "cheque"] as const;
export const PAYMENT_STATUSES = ["recorded", "reversed"] as const;

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey(), // may be generated on the device
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    fy: char("fy", { length: 5 }).notNull(),
    receiptNumber: varchar("receipt_number", { length: 16 }), // set for customer receipts
    direction: text("direction").$type<(typeof PAYMENT_DIRECTIONS)[number]>().notNull(),
    partyType: text("party_type").$type<(typeof PAYMENT_PARTY_TYPES)[number]>().notNull(),
    partyId: uuid("party_id"),
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    creditNoteId: uuid("credit_note_id").references(() => creditNotes.id),
    method: text("method").$type<(typeof PAYMENT_METHODS)[number]>().notNull(),
    amountPaise: paise("amount_paise").notNull(),
    reference: varchar("reference", { length: 40 }), // UPI UTR / cheque no.
    businessDate: date("business_date", { mode: "string" }).notNull(),
    recordedBy: uuid("recorded_by").notNull().references(() => users.id),
    deviceId: uuid("device_id").references(() => devices.id),
    status: text("status").$type<(typeof PAYMENT_STATUSES)[number]>().notNull().default("recorded"),
    reversedByPaymentId: uuid("reversed_by_payment_id").references((): AnyPgColumn => payments.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("payments_no_duplicate_ref")
      .on(t.shopId, t.method, t.reference)
      .where(sql`${t.reference} is not null and ${t.status} = 'recorded' and ${t.method} in ('upi', 'cheque', 'bank')`),
    index("payments_shop_business_date_idx").on(t.shopId, t.businessDate),
    index("payments_party_business_date_idx").on(t.partyType, t.partyId, t.businessDate),
    check("payments_direction_check", oneOf(t.direction, PAYMENT_DIRECTIONS)),
    check("payments_party_type_check", oneOf(t.partyType, PAYMENT_PARTY_TYPES)),
    check("payments_method_check", oneOf(t.method, PAYMENT_METHODS)),
    check("payments_status_check", oneOf(t.status, PAYMENT_STATUSES)),
    check("payments_amount_check", sql`${t.amountPaise} > 0`),
  ],
);
