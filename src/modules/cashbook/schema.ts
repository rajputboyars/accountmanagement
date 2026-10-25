import { sql } from "drizzle-orm";
import { check, date, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "../identity/schema";
import { shops } from "../settings/schema";
import { createdAt, id, oneOf, paise } from "../../server/schema-helpers";

/** Owned by the cashbook module: expenses, cash taken out, and the daily closing snapshot. */

export const EXPENSE_METHODS = ["cash", "upi", "bank"] as const;
export const EXPENSE_STATUSES = ["recorded", "voided"] as const;
export const CASH_MOVEMENT_KINDS = ["withdrawal", "bank_deposit", "float_added"] as const;
export const DAY_CLOSING_STATUSES = ["closed", "reopened"] as const;

export const expenses = pgTable(
  "expenses",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    category: text("category").notNull(),
    amountPaise: paise("amount_paise").notNull(),
    method: text("method").$type<(typeof EXPENSE_METHODS)[number]>().notNull(),
    note: text("note"),
    status: text("status").$type<(typeof EXPENSE_STATUSES)[number]>().notNull().default("recorded"),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    check("expenses_amount_check", sql`${t.amountPaise} > 0`),
    check("expenses_method_check", oneOf(t.method, EXPENSE_METHODS)),
    check("expenses_status_check", oneOf(t.status, EXPENSE_STATUSES)),
  ],
);

export const cashMovements = pgTable(
  "cash_movements",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    kind: text("kind").$type<(typeof CASH_MOVEMENT_KINDS)[number]>().notNull(),
    amountPaise: paise("amount_paise").notNull(),
    note: text("note"),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    check("cash_movements_kind_check", oneOf(t.kind, CASH_MOVEMENT_KINDS)),
    check("cash_movements_amount_check", sql`${t.amountPaise} > 0`),
  ],
);

/** One row per business day. The snapshot freezes the day's figures; a closed day's report never changes. */
export const dayClosings = pgTable(
  "day_closings",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    status: text("status").$type<(typeof DAY_CLOSING_STATUSES)[number]>().notNull(),
    openingCashPaise: paise("opening_cash_paise").notNull(),
    expectedCashPaise: paise("expected_cash_paise").notNull(),
    countedCashPaise: paise("counted_cash_paise").notNull(),
    differencePaise: paise("difference_paise").notNull(),
    differenceReason: text("difference_reason"),
    snapshot: jsonb("snapshot").notNull(), // sales, collections by method, credit given, expenses, purchases
    closedBy: uuid("closed_by").notNull().references(() => users.id),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull(),
    reopenedBy: uuid("reopened_by").references(() => users.id),
    reopenedAt: timestamp("reopened_at", { withTimezone: true }),
    reopenReason: text("reopen_reason"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("day_closings_shop_business_date_key").on(t.shopId, t.businessDate),
    check("day_closings_status_check", oneOf(t.status, DAY_CLOSING_STATUSES)),
    check("day_closings_reason_check", sql`${t.differencePaise} = 0 or ${t.differenceReason} is not null`),
  ],
);
