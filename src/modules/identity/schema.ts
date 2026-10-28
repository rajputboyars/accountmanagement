import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { devices, shops } from "../settings/schema";
import { createdAt, id, oneOf } from "../../server/schema-helpers";

/** Owned by the identity module: people, permissions, sessions, OTPs and owner approvals. */

export const ROLES = ["owner", "manager", "cashier", "inventory"] as const;
export type Role = (typeof ROLES)[number];

export const users = pgTable(
  "users",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    name: text("name").notNull(),
    phone: varchar("phone", { length: 10 }).notNull(),
    role: text("role").$type<Role>().notNull(),
    pinHash: text("pin_hash"), // owner approval PIN, Argon2id
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("users_shop_phone_key").on(t.shopId, t.phone),
    uniqueIndex("one_owner_per_shop").on(t.shopId).where(sql`${t.role} = 'owner'`),
    check("users_role_check", oneOf(t.role, ROLES)),
  ],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    role: text("role").$type<Role>().notNull(),
    permission: text("permission").notNull(),
    allowed: boolean("allowed").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.shopId, t.role, t.permission] })],
);

export const sessions = pgTable("sessions", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id),
  deviceId: uuid("device_id").references(() => devices.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const otpRequests = pgTable(
  "otp_requests",
  {
    id: id(),
    phone: varchar("phone", { length: 10 }).notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: smallint("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("otp_requests_phone_expires_idx").on(t.phone, t.expiresAt)],
);

export const APPROVAL_ACTIONS = [
  "discount_over_limit",
  "below_cost",
  "credit_over_limit",
  "edit_invoice",
  "stock_adjustment",
  "reopen_day",
] as const;

/** Single-use owner approval tied to one action and target. */
export const approvals = pgTable("approvals", {
  id: id(),
  shopId: uuid("shop_id").notNull().references(() => shops.id),
  action: text("action").$type<(typeof APPROVAL_ACTIONS)[number]>().notNull(),
  targetType: text("target_type").notNull(),
  targetRef: text("target_ref").notNull(),
  payload: jsonb("payload").notNull(),
  requestedBy: uuid("requested_by").notNull().references(() => users.id),
  approvedBy: uuid("approved_by").references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/** In-app alerts, one row per recipient; `dedupe_key` stops the same alert being raised twice. */
export const NOTIFICATION_KINDS = ["low_stock", "dues_overdue", "supplier_overdue", "approval_requested", "approval_decided", "whatsapp_failed", "import_finished"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind").$type<NotificationKind>().notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    href: text("href"),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: createdAt(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [
    check("notifications_kind_check", oneOf(t.kind, NOTIFICATION_KINDS)),
    uniqueIndex("notifications_user_dedupe_key").on(t.userId, t.dedupeKey),
    index("notifications_user_created_idx").on(t.userId, t.createdAt),
  ],
);

/** A person's choice to mute a kind of in-app alert (no row = on). */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id),
    kind: text("kind").$type<NotificationKind>().notNull(),
    inApp: boolean("in_app").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind] }), check("notification_preferences_kind_check", oneOf(t.kind, NOTIFICATION_KINDS))],
);
