import { jsonb, pgTable, primaryKey, smallint, text, uuid } from "drizzle-orm/pg-core";
import { createdAt } from "../../server/schema-helpers";

/**
 * Owned by the sync module. Every write endpoint stores its response under the caller's
 * Idempotency-Key: the same key with the same body returns the stored response; the same key
 * with a different body is refused (409).
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    shopId: uuid("shop_id").notNull(),
    key: text("key").notNull(),
    userId: uuid("user_id").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response").notNull(),
    statusCode: smallint("status_code").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.shopId, t.key] })],
);
