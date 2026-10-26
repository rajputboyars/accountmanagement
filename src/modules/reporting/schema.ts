import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { customers } from "../parties/schema";
import { shops } from "../settings/schema";
import { users } from "../identity/schema";
import { createdAt, id, oneOf } from "../../server/schema-helpers";

/**
 * Owned by the reporting module: the WhatsApp outbox. A message is queued inside the request, then
 * sent by the outbox worker with retries; the provider's webhook moves it to delivered/read/failed.
 * `dedupe_key` stops the same reminder being queued twice.
 */
export const WHATSAPP_STATUSES = ["queued", "sending", "sent", "delivered", "read", "failed"] as const;
export type WhatsAppStatus = (typeof WHATSAPP_STATUSES)[number];

export const whatsappMessages = pgTable(
  "whatsapp_messages",
  {
    id: id(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    phone: varchar("phone", { length: 15 }).notNull(),
    purpose: text("purpose").notNull(), // 'dues_reminder'
    body: text("body").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status").$type<WhatsAppStatus>().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    providerMessageId: text("provider_message_id"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("whatsapp_messages_status_check", oneOf(t.status, WHATSAPP_STATUSES)),
    uniqueIndex("whatsapp_messages_shop_dedupe_key").on(t.shopId, t.dedupeKey),
    uniqueIndex("whatsapp_messages_provider_id_key").on(t.providerMessageId).where(sql`${t.providerMessageId} is not null`),
    index("whatsapp_messages_due_idx").on(t.status, t.nextAttemptAt),
    index("whatsapp_messages_customer_idx").on(t.shopId, t.customerId, t.createdAt),
  ],
);
