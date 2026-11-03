import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { shops } from "../settings/schema";
import { createdAt, id, oneOf, paise } from "../../server/schema-helpers";
import { LANGUAGES, type Language } from "../../shared/i18n/languages";

/** Owned by the parties module: customers and suppliers. Balances live in the ledger module. */

export const CUSTOMER_TYPES = ["walkin", "retail", "wholesale"] as const;

export const customers = pgTable(
  "customers",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    name: text("name").notNull(),
    phone: varchar("phone", { length: 10 }),
    gstin: varchar("gstin", { length: 15 }),
    area: text("area"),
    type: text("type").$type<(typeof CUSTOMER_TYPES)[number]>().notNull(),
    creditLimitPaise: paise("credit_limit_paise").notNull().default(0),
    /** The customer agreed to payment reminders on WhatsApp. Reminders are never prepared without it. */
    whatsappConsent: boolean("whatsapp_consent").notNull().default(false),
    consentUpdatedAt: timestamp("consent_updated_at", { withTimezone: true }),
    /** The language this customer reads messages in. Null until someone chooses; never taken from staff settings. */
    communicationLanguage: text("communication_language").$type<Language>(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("customers_shop_phone_key").on(t.shopId, t.phone).where(sql`${t.phone} is not null`),
    uniqueIndex("one_walkin_per_shop").on(t.shopId).where(sql`${t.type} = 'walkin'`),
    check("customers_type_check", oneOf(t.type, CUSTOMER_TYPES)),
    check("customers_communication_language_check", oneOf(t.communicationLanguage, LANGUAGES)),
    check("customers_credit_limit_check", sql`${t.creditLimitPaise} >= 0`),
  ],
);

export const suppliers = pgTable("suppliers", {
  id: id(),
  shopId: uuid("shop_id").notNull().references(() => shops.id),
  name: text("name").notNull(),
  phone: varchar("phone", { length: 15 }),
  gstin: varchar("gstin", { length: 15 }),
  paymentTermsDays: integer("payment_terms_days").notNull().default(30),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
});
