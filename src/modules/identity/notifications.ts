import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import { getDb, withTransaction, type Database, type Transaction } from "@/server/db";
import { NotFoundError, ValidationError } from "@/server/errors";
import type { Permission } from "@/shared/permissions";
import { NOTIFICATION_KINDS, notificationPreferences, notifications, rolePermissions, users, type NotificationKind } from "./schema";
import type { SessionContext } from "./sessions";

/**
 * In-app notifications: one row per recipient, raised by the module that knows about the event
 * (approvals here, stock/dues/WhatsApp in reporting). Recipients are active staff of the same shop who
 * hold the permission that lets them act on it; a person can mute a kind. `dedupeKey` (with the
 * recipient) is unique, so raising the same alert twice is a no-op. Nothing here sends SMS/WhatsApp to
 * staff; the bell and the Notifications page are the channel.
 */

export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  low_stock: "Low or out of stock",
  dues_overdue: "Customer dues overdue",
  approval_requested: "Approval requests",
  approval_decided: "Approval decisions",
  whatsapp_failed: "WhatsApp messages that failed",
  import_finished: "Imports finished",
};

export type NewNotification = {
  shopId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  href?: string | null;
  dedupeKey: string;
  /** Specific people, or everyone active in the shop whose role holds this permission. */
  to: { userIds: string[] } | { permission: Permission };
};

/** Raises an alert for its recipients, skipping people who muted the kind and alerts already raised. Returns rows created. */
export async function raiseNotification(alert: NewNotification, db: Database | Transaction = getDb()): Promise<number> {
  const recipients =
    "userIds" in alert.to
      ? alert.to.userIds.length
        ? await db.select({ id: users.id }).from(users).where(and(eq(users.shopId, alert.shopId), eq(users.isActive, true), inArray(users.id, alert.to.userIds)))
        : []
      : await db
          .select({ id: users.id })
          .from(users)
          .innerJoin(rolePermissions, and(eq(rolePermissions.shopId, users.shopId), eq(rolePermissions.role, users.role), eq(rolePermissions.permission, alert.to.permission), eq(rolePermissions.allowed, true)))
          .where(and(eq(users.shopId, alert.shopId), eq(users.isActive, true)));
  if (recipients.length === 0) return 0;
  const muted = new Set(
    (
      await db
        .select({ userId: notificationPreferences.userId })
        .from(notificationPreferences)
        .where(and(eq(notificationPreferences.shopId, alert.shopId), eq(notificationPreferences.kind, alert.kind), eq(notificationPreferences.inApp, false), inArray(notificationPreferences.userId, recipients.map((row) => row.id))))
    ).map((row) => row.userId),
  );
  const values = recipients.filter((row) => !muted.has(row.id)).map((row) => ({ shopId: alert.shopId, userId: row.id, kind: alert.kind, title: alert.title.slice(0, 200), body: alert.body.slice(0, 600), href: alert.href ?? null, dedupeKey: alert.dedupeKey }));
  if (values.length === 0) return 0;
  const created = await db.insert(notifications).values(values).onConflictDoNothing({ target: [notifications.userId, notifications.dedupeKey] }).returning({ id: notifications.id });
  return created.length;
}

/** Approval alerts: the owner (`approvals.decide`) on a request, the requester on a decision. */
export type NotificationResult = { delivered: boolean; channel: "in_app"; note: string };

export async function notifyApprovalEvent(
  shopId: string,
  event:
    | { type: "requested"; approvalId: string; requesterName: string; actionLabel: string; targetLabel: string }
    | { type: "decided"; approvalId: string; recipientUserId: string; actionLabel: string; targetLabel: string; decision: "approved" | "rejected"; decisionReason: string | null },
): Promise<NotificationResult> {
  if (event.type === "requested") {
    await raiseNotification({ shopId, kind: "approval_requested", title: `${event.requesterName} asks: ${event.actionLabel}`, body: event.targetLabel, href: "/approvals", dedupeKey: `approval:${event.approvalId}:requested`, to: { permission: "approvals.decide" } });
    return { delivered: false, channel: "in_app", note: "The owner is notified in Nexora (no SMS or WhatsApp to staff)." };
  }
  await raiseNotification({
    shopId,
    kind: "approval_decided",
    title: `${event.actionLabel} ${event.decision}`,
    body: `${event.targetLabel}${event.decisionReason ? ` · ${event.decisionReason}` : ""}${event.decision === "approved" ? " · Save again within 10 minutes." : ""}`,
    href: "/approvals",
    dedupeKey: `approval:${event.approvalId}:decided`,
    to: { userIds: [event.recipientUserId] },
  });
  return { delivered: false, channel: "in_app", note: `The requester is notified in Nexora.` };
}

// ── The person's own inbox ───────────────────────────────────────────────────

export async function listNotifications(session: SessionContext, options: { unreadOnly?: boolean; limit?: number } = {}) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  return getDb()
    .select({ id: notifications.id, kind: notifications.kind, title: notifications.title, body: notifications.body, href: notifications.href, createdAt: notifications.createdAt, readAt: notifications.readAt })
    .from(notifications)
    .where(and(eq(notifications.shopId, session.shopId), eq(notifications.userId, session.userId), options.unreadOnly ? isNull(notifications.readAt) : undefined))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

export async function countUnreadNotifications(session: SessionContext): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.shopId, session.shopId), eq(notifications.userId, session.userId), isNull(notifications.readAt)));
  return row?.count ?? 0;
}

/** Marks one (or, with no id, all) of the person's own notifications read. Others' rows are never touched. */
export async function markNotificationsRead(session: SessionContext, notificationId?: string): Promise<number> {
  if (notificationId !== undefined && !/^[0-9a-f-]{36}$/i.test(notificationId)) throw new NotFoundError("Notification not found.");
  const rows = await getDb()
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(and(eq(notifications.shopId, session.shopId), eq(notifications.userId, session.userId), isNull(notifications.readAt), notificationId ? eq(notifications.id, notificationId) : undefined))
    .returning({ id: notifications.id });
  return rows.length;
}

export async function getNotificationPreferences(session: SessionContext) {
  const rows = await getDb().select({ kind: notificationPreferences.kind, inApp: notificationPreferences.inApp }).from(notificationPreferences).where(and(eq(notificationPreferences.shopId, session.shopId), eq(notificationPreferences.userId, session.userId)));
  const set = new Map(rows.map((row) => [row.kind, row.inApp]));
  return NOTIFICATION_KINDS.map((kind) => ({ kind, label: NOTIFICATION_KIND_LABELS[kind], inApp: set.get(kind) ?? true }));
}

/** Turns a kind of alert on or off for the person themselves; audited. */
export async function setNotificationPreference(session: SessionContext, kind: string, inApp: boolean) {
  if (!(NOTIFICATION_KINDS as readonly string[]).includes(kind)) throw new ValidationError("Choose a kind of alert.");
  await withTransaction(async (tx) => {
    await tx
      .insert(notificationPreferences)
      .values({ userId: session.userId, shopId: session.shopId, kind: kind as NotificationKind, inApp })
      .onConflictDoUpdate({ target: [notificationPreferences.userId, notificationPreferences.kind], set: { inApp, updatedAt: sql`now()` } });
    await recordAudit(tx, { shopId: session.shopId, userId: session.userId, role: session.role }, { action: "identity.notification_preference_set", entityType: "user", entityId: session.userId, after: { kind, inApp } });
  });
}
