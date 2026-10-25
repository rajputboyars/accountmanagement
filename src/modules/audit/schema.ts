import { bigint, boolean, index, inet, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Owned by the audit module. Append-only (trigger in migration 0002). Every write in the app
 * records one row here inside its own transaction. No foreign keys, so audit rows outlive
 * anything they describe.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    shopId: uuid("shop_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    userId: uuid("user_id"),
    role: text("role"),
    deviceId: uuid("device_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
    approvalId: uuid("approval_id"),
    offline: boolean("offline").notNull().default(false),
    ip: inet("ip"),
  },
  (t) => [index("audit_log_shop_at_idx").on(t.shopId, t.at.desc()), index("audit_log_entity_idx").on(t.entityType, t.entityId)],
);
