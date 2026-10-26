import { sql } from "drizzle-orm";
import { bigint, boolean, char, check, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { createdAt, id } from "../../server/schema-helpers";

/** Owned by the settings module: the shop, its counters, and document number series. */

export const shops = pgTable("shops", {
  id: id(),
  name: text("name").notNull(),
  legalName: text("legal_name"),
  gstin: varchar("gstin", { length: 15 }),
  stateCode: char("state_code", { length: 2 }).notNull(), // '08' = Rajasthan
  address: text("address"),
  phone: varchar("phone", { length: 15 }),
  fyStartMonth: smallint("fy_start_month").notNull().default(4),
  openingCashPaise: bigint("opening_cash_paise", { mode: "number" }).notNull().default(0),
  settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`), // invoice extras: terms, UPI id, bank details
  /** GST treatment (src/shared/gst.ts). Existing shops keep charging GST as before ('regular'). */
  gstRegistration: text("gst_registration").notNull().default("regular"),
  interStateSales: boolean("inter_state_sales").notNull().default(false),
  /** GST rates offered for products, in basis points (a subset of the statutory rates). */
  gstRatesBp: integer("gst_rates_bp").array().notNull().default(sql`'{0,500,1200,1800,2800}'::integer[]`),
  /** Rendered before invoice numbers, e.g. INV/26-27/00001 (≤ 4 letters keeps it within 16 characters). */
  invoicePrefix: varchar("invoice_prefix", { length: 4 }).notNull().default("INV"),
  createdAt: createdAt(),
}, (t) => [check("shops_gst_registration_check", sql`${t.gstRegistration} in ('regular', 'composition', 'unregistered')`), check("shops_invoice_prefix_check", sql`${t.invoicePrefix} ~ '^[A-Z]{1,4}$'`)]);

export const devices = pgTable("devices", {
  id: id(),
  shopId: uuid("shop_id").notNull().references(() => shops.id),
  name: text("name").notNull(), // 'Counter 1', 'Wholesale desk'
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
});

/** INV, CN, RCPT, PO, GRN, ADJ per financial year ('26-27'). Incremented inside the document's transaction. */
export const numberSeries = pgTable(
  "number_series",
  {
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    series: text("series").notNull(),
    fy: char("fy", { length: 5 }).notNull(),
    nextValue: integer("next_value").notNull().default(1),
    /** First number of the year (Settings → Invoice); numbering has started once next_value passes it. */
    startValue: integer("start_value").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.shopId, t.series, t.fy] })],
);

/** Numbers reserved for one device to use while offline. */
export const numberBlocks = pgTable(
  "number_blocks",
  {
    id: id(),
    deviceId: uuid("device_id").notNull().references(() => devices.id),
    series: text("series").notNull(),
    fy: char("fy", { length: 5 }).notNull(),
    firstValue: integer("first_value").notNull(),
    lastValue: integer("last_value").notNull(),
    nextValue: integer("next_value").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("number_blocks_range", sql`${t.firstValue} <= ${t.nextValue} and ${t.nextValue} <= ${t.lastValue} + 1`),
  ],
);
