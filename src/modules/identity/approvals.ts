import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/modules/audit";
import { getDb, withTransaction, type Transaction } from "@/server/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import type { Permission } from "@/shared/permissions";
import { requirePermission } from "./authorization";
import { notifyApprovalEvent, type NotificationResult } from "./notifications";
import { APPROVAL_ACTIONS, approvals, users } from "./schema";
import type { SessionContext } from "./sessions";
import { loadUserNames } from "./staff";

/**
 * Owner approvals for high-risk actions (handoff §2.3): single use, expire after 10 minutes, never
 * decided by the person who asked. A staff member asks from the Approvals screen; the owner approves or
 * rejects (a reason is required to reject); when the requester then saves the bill, adjustment or
 * correction, the service uses a matching approval inside its own transaction (`consumeMatchingApproval`)
 * — same requester, same record, within the approved limit — and marks it used, exactly once. The owner
 * PIN entered on the spot stays as the other route. Rows are never deleted; every step is audited.
 */

export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export const APPROVAL_ACTION_LABELS: Record<ApprovalAction, string> = {
  discount_over_limit: "Discount above limit",
  below_cost: "Below cost price",
  credit_over_limit: "Credit above limit",
  edit_invoice: "Bill correction",
  stock_adjustment: "Large stock adjustment",
  reopen_day: "Reopen closed day",
};

/**
 * Actions staff can ask for here. "below_cost" (slab below cost, C15) and "reopen_day" are owner-only
 * screens already, so the owner does them directly and no request is needed.
 */
export const REQUESTABLE_ACTIONS = ["discount_over_limit", "credit_over_limit", "stock_adjustment", "edit_invoice"] as const satisfies readonly ApprovalAction[];
export type RequestableAction = (typeof REQUESTABLE_ACTIONS)[number];

/** What each request is about and who may ask for it (the asker must be allowed to do the action itself). */
const REQUEST_RULES: Record<RequestableAction, { targetType: string; permission: Permission }> = {
  discount_over_limit: { targetType: "customer", permission: "billing.create" },
  credit_over_limit: { targetType: "customer", permission: "billing.create" },
  stock_adjustment: { targetType: "product", permission: "stock.adjust" },
  edit_invoice: { targetType: "invoice", permission: "invoice.edit" },
};

/** Discount approvals may name "any customer" (walk-in or not yet chosen). */
export const ANY_TARGET = "any";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "used" | "expired";

export type ApprovalPayload = {
  reason: string;
  /** Shown to the owner; resolved on the server from the record, never typed by the requester. */
  targetLabel?: string | null;
  /** Credit: highest dues allowed after the bill. Stock adjustment: highest value at cost. */
  amountPaise?: number | null;
  /** Discount: highest discount allowed, in basis points. */
  limitBp?: number | null;
  quantity?: string | null;
  unit?: string | null;
  status?: "pending" | "approved" | "rejected";
  decisionReason?: string | null;
  rejectedBy?: string | null;
  rejectedAt?: string | null;
  approvedAt?: string | null;
};

export type ApprovalView = {
  id: string;
  action: ApprovalAction;
  actionLabel: string;
  targetType: string;
  targetRef: string;
  targetLabel: string;
  reason: string;
  amountPaise: number | null;
  limitBp: number | null;
  quantity: string | null;
  unit: string | null;
  requestedBy: string;
  requesterName: string;
  requesterRole: string;
  approvedBy: string | null;
  decisionByName: string | null;
  status: ApprovalStatus;
  decisionReason: string | null;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  canDecide: boolean;
};

export const APPROVAL_EXPIRY_MS = 10 * 60 * 1000; // handoff §2.3: expires after 10 minutes

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actorOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId, role: session.role });
const payloadOf = (value: unknown): ApprovalPayload => (value as ApprovalPayload | null) ?? { reason: "" };

export function resolveApprovalStatus(row: { approvedBy: string | null; usedAt: Date | null; expiresAt: Date; payload: unknown }, now = new Date()): ApprovalStatus {
  if (row.usedAt !== null) return "used";
  const payload = payloadOf(row.payload);
  if (payload.status === "rejected") return "rejected";
  if (now > row.expiresAt) return "expired";
  return row.approvedBy !== null ? "approved" : "pending";
}

const requestSchema = z
  .object({
    action: z.enum(REQUESTABLE_ACTIONS, { error: "Choose what needs approval." }),
    targetRef: z.string().trim().min(1, "Choose the record this is for.").max(120),
    targetLabel: z.string().trim().min(1).max(160),
    reason: z.string().trim().min(3, "Write the reason (at least 3 characters).").max(300, "Keep the reason under 300 characters."),
    amountPaise: z.number().int().positive().nullable().optional(),
    limitBp: z.number().int().min(1).max(10_000).nullable().optional(),
    quantity: z.string().trim().max(30).nullable().optional(),
    unit: z.string().trim().max(20).nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.action === "discount_over_limit" && !data.limitBp) ctx.addIssue({ code: "custom", path: ["limitBp"], message: "Enter the discount % you need." });
    if (data.action === "credit_over_limit" && !data.amountPaise) ctx.addIssue({ code: "custom", path: ["amountPaise"], message: "Enter the highest dues allowed after this bill." });
    if ((data.action === "credit_over_limit" || data.action === "stock_adjustment") && !UUID.test(data.targetRef)) ctx.addIssue({ code: "custom", path: ["targetRef"], message: "Choose the record this is for." });
    if (data.action === "discount_over_limit" && data.targetRef !== ANY_TARGET && !UUID.test(data.targetRef)) ctx.addIssue({ code: "custom", path: ["targetRef"], message: "Choose the customer." });
  });

/**
 * A staff member asks the owner. The caller (app layer) resolves `targetLabel` from the record on the
 * server. The same pending request (same person, action and record) is returned instead of a duplicate.
 */
export async function requestApproval(session: SessionContext, input: unknown): Promise<ApprovalView & { duplicate: boolean; notification: NotificationResult }> {
  const data = requestSchema.parse(input);
  const rule = REQUEST_RULES[data.action];
  await requirePermission(session, rule.permission);
  if (session.role === "owner") throw new ConflictError("OWNER_NO_APPROVAL", "The owner can do this directly; no approval is needed.");

  const outcome = await withTransaction(async (tx) => {
    // Serialise requests for the same person, action and record, so a double tap makes one request.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`approval:${session.shopId}:${session.userId}:${data.action}:${data.targetRef}`}))`);
    const [existing] = await tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.shopId, session.shopId),
          eq(approvals.requestedBy, session.userId),
          eq(approvals.action, data.action),
          eq(approvals.targetRef, data.targetRef),
          sql`${approvals.approvedBy} is null`,
          sql`${approvals.usedAt} is null`,
          sql`${approvals.expiresAt} > now()`,
          sql`coalesce(${approvals.payload}->>'status', 'pending') = 'pending'`,
        ),
      )
      .limit(1);
    if (existing) return { row: existing, duplicate: true };

    const payload: ApprovalPayload = {
      reason: data.reason,
      targetLabel: data.targetLabel,
      amountPaise: data.amountPaise ?? null,
      limitBp: data.limitBp ?? null,
      quantity: data.quantity ?? null,
      unit: data.unit ?? null,
      status: "pending",
    };
    const [row] = await tx
      .insert(approvals)
      .values({ shopId: session.shopId, action: data.action, targetType: rule.targetType, targetRef: data.targetRef, payload, requestedBy: session.userId, expiresAt: sql`now() + interval '10 minutes'` })
      .returning();
    await recordAudit(tx, actorOf(session), {
      action: "identity.approval_requested",
      entityType: "approval",
      entityId: row!.id,
      approvalId: row!.id,
      after: { action: data.action, targetType: rule.targetType, targetRef: data.targetRef, targetLabel: data.targetLabel, amountPaise: payload.amountPaise, limitBp: payload.limitBp, quantity: payload.quantity },
      reason: data.reason,
    });
    return { row: row!, duplicate: false };
  });

  const view = toView(outcome.row, { name: session.name, role: session.role }, null, session);
  const notification = outcome.duplicate
    ? { delivered: false, channel: "in_app" as const, note: "This request was already waiting for the owner." }
    : await notifyApprovalEvent(session.shopId, { type: "requested", requesterName: session.name, actionLabel: view.actionLabel, targetLabel: view.targetLabel });
  return { ...view, duplicate: outcome.duplicate, notification };
}

const decideSchema = z.object({
  approvalId: z.string().regex(UUID, "Choose a request."),
  decision: z.enum(["approve", "reject"], { error: "Choose approve or reject." }),
  reason: z.string().trim().max(300, "Keep the reason under 300 characters.").optional(),
});

/** Owner (`approvals.decide`): approve or reject a pending request. Never one's own; a reason is required to reject. */
export async function decideApproval(session: SessionContext, input: unknown): Promise<ApprovalView> {
  await requirePermission(session, "approvals.decide");
  const data = decideSchema.parse(input);
  const decisionReason = data.reason?.trim() || null;
  if (data.decision === "reject" && (!decisionReason || decisionReason.length < 3)) {
    throw new ValidationError("Write why you are rejecting this request.", { fieldErrors: { reason: "Write why you are rejecting this request." } });
  }

  const result = await withTransaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, data.approvalId), eq(approvals.shopId, session.shopId)))
      .for("update")
      .limit(1);
    if (!row) throw new NotFoundError("Approval request not found.");
    if (row.requestedBy === session.userId) throw new ForbiddenError("You can't decide your own request.");
    const status = resolveApprovalStatus(row);
    if (status === "expired") throw new ConflictError("APPROVAL_EXPIRED", "This request has expired (requests last 10 minutes). Ask for a new one.");
    if (status !== "pending") throw new ConflictError("ALREADY_DECIDED", `This request was already ${status === "used" ? "used" : status}.`);

    const now = new Date().toISOString();
    const approve = data.decision === "approve";
    const payload: ApprovalPayload = { ...payloadOf(row.payload), status: approve ? "approved" : "rejected", decisionReason, ...(approve ? { approvedAt: now } : { rejectedBy: session.userId, rejectedAt: now }) };
    const [updated] = await tx
      .update(approvals)
      .set({ approvedBy: approve ? session.userId : null, payload })
      .where(and(eq(approvals.id, row.id), eq(approvals.shopId, session.shopId)))
      .returning();
    await recordAudit(tx, actorOf(session), {
      action: approve ? "identity.approval_approved" : "identity.approval_rejected",
      entityType: "approval",
      entityId: row.id,
      approvalId: row.id,
      before: { status: "pending" },
      after: { status: approve ? "approved" : "rejected", action: row.action, targetRef: row.targetRef },
      reason: decisionReason,
    });
    return updated!;
  });

  const [requester] = await getDb().select({ name: users.name, role: users.role }).from(users).where(and(eq(users.id, result.requestedBy), eq(users.shopId, session.shopId)));
  const view = toView(result, requester ?? { name: "Staff", role: "staff" }, session.name, session);
  await notifyApprovalEvent(session.shopId, { type: "decided", recipientUserId: result.requestedBy, actionLabel: view.actionLabel, targetLabel: view.targetLabel, decision: view.status === "approved" ? "approved" : "rejected", decisionReason });
  return view;
}

type ApprovalRow = typeof approvals.$inferSelect;

async function markUsed(tx: Transaction, session: SessionContext, row: ApprovalRow) {
  await tx.update(approvals).set({ usedAt: sql`now()` }).where(and(eq(approvals.id, row.id), eq(approvals.shopId, session.shopId)));
  await recordAudit(tx, actorOf(session), { action: "identity.approval_used", entityType: "approval", entityId: row.id, approvalId: row.id, after: { action: row.action, targetRef: row.targetRef } });
  return { id: row.id, payload: payloadOf(row.payload) };
}

function usableProblem(row: ApprovalRow, session: SessionContext, action: ApprovalAction, targetRefs: readonly string[]): ConflictError | ForbiddenError | null {
  if (row.action !== action) return new ConflictError("APPROVAL_MISMATCH", `This approval is for "${APPROVAL_ACTION_LABELS[row.action]}", not "${APPROVAL_ACTION_LABELS[action]}".`);
  if (row.requestedBy !== session.userId) return new ForbiddenError("Only the person who asked can use this approval.");
  if (!targetRefs.includes(row.targetRef)) return new ConflictError("APPROVAL_MISMATCH", "This approval is for a different record.");
  const status = resolveApprovalStatus(row);
  if (status === "rejected") return new ConflictError("APPROVAL_REJECTED", `The owner rejected this request: ${payloadOf(row.payload).decisionReason ?? "no reason given"}.`);
  if (status === "used") return new ConflictError("APPROVAL_ALREADY_USED", "This approval was already used. Ask for a new one.");
  if (status === "expired") return new ConflictError("APPROVAL_EXPIRED", "This approval has expired (10 minutes). Ask for a new one.");
  if (status !== "approved") return new ConflictError("APPROVAL_NOT_APPROVED", "The owner hasn't approved this request yet.");
  if (row.approvedBy === row.requestedBy) return new ForbiddenError("A request can't be approved by the person who made it.");
  return null;
}

/**
 * Uses one specific approval inside the caller's transaction (row locked, checked, marked used, audited).
 * If the caller's transaction rolls back, the approval stays unused.
 */
export async function consumeApproval(
  tx: Transaction,
  session: SessionContext,
  approvalId: string,
  action: ApprovalAction,
  targetRefs: readonly string[],
  accept: (payload: ApprovalPayload) => string | null = () => null,
): Promise<{ id: string; payload: ApprovalPayload }> {
  if (!UUID.test(approvalId)) throw new NotFoundError("Approval not found.");
  const [row] = await tx
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, approvalId), eq(approvals.shopId, session.shopId)))
    .for("update")
    .limit(1);
  if (!row) throw new NotFoundError("Approval not found.");
  const problem = usableProblem(row, session, action, targetRefs) ?? (() => {
    const message = accept(payloadOf(row.payload));
    return message ? new ConflictError("APPROVAL_LIMIT", message) : null;
  })();
  if (problem) throw problem;
  return markUsed(tx, session, row);
}

/**
 * Finds and uses the requester's oldest approved, unused, unexpired approval for this action and record
 * that covers what is being done (`accept` returns null when it does). Returns null when there is none.
 * Locked rows (another save using the same approval at this moment) wait, then are re-checked, so an
 * approval is used once.
 */
export async function consumeMatchingApproval(
  tx: Transaction,
  session: SessionContext,
  action: ApprovalAction,
  targetRefs: readonly string[],
  accept: (payload: ApprovalPayload) => string | null = () => null,
): Promise<{ id: string; payload: ApprovalPayload } | null> {
  if (targetRefs.length === 0) return null;
  const rows = await tx
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.shopId, session.shopId),
        eq(approvals.requestedBy, session.userId),
        eq(approvals.action, action),
        inArray(approvals.targetRef, [...targetRefs]),
        sql`${approvals.approvedBy} is not null`,
        sql`${approvals.usedAt} is null`,
        sql`${approvals.expiresAt} > now()`,
      ),
    )
    .orderBy(asc(approvals.createdAt))
    .for("update");
  for (const row of rows) {
    if (usableProblem(row, session, action, targetRefs) === null && accept(payloadOf(row.payload)) === null) return markUsed(tx, session, row);
  }
  return null;
}

function toView(row: ApprovalRow, requester: { name: string; role: string }, decisionByName: string | null, session: SessionContext): ApprovalView {
  const payload = payloadOf(row.payload);
  const status = resolveApprovalStatus(row);
  return {
    id: row.id,
    action: row.action,
    actionLabel: APPROVAL_ACTION_LABELS[row.action],
    targetType: row.targetType,
    targetRef: row.targetRef,
    targetLabel: payload.targetLabel ?? row.targetRef,
    reason: payload.reason,
    amountPaise: payload.amountPaise ?? null,
    limitBp: payload.limitBp ?? null,
    quantity: payload.quantity ?? null,
    unit: payload.unit ?? null,
    requestedBy: row.requestedBy,
    requesterName: requester.name,
    requesterRole: requester.role,
    approvedBy: row.approvedBy,
    decisionByName,
    status,
    decisionReason: payload.decisionReason ?? null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    canDecide: session.role === "owner" && session.userId !== row.requestedBy && status === "pending",
  };
}

/** Inbox: people with `approvals.decide` see the shop's requests; everyone else sees their own. Newest first. */
export async function listApprovals(session: SessionContext, options: { status?: "pending" | "resolved" | "all"; limit?: number } = {}): Promise<ApprovalView[]> {
  await requirePermission(session, "approvals.view");
  const seesAll = session.role === "owner";
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const rows = await getDb()
    .select({ approval: approvals, requesterName: users.name, requesterRole: users.role })
    .from(approvals)
    .innerJoin(users, eq(users.id, approvals.requestedBy))
    .where(and(eq(approvals.shopId, session.shopId), seesAll ? undefined : eq(approvals.requestedBy, session.userId)))
    .orderBy(desc(approvals.createdAt))
    .limit(limit);
  const deciderIds = rows.map(({ approval }) => approval.approvedBy ?? payloadOf(approval.payload).rejectedBy).filter((value): value is string => Boolean(value));
  const names = await loadUserNames(session.shopId, [...new Set(deciderIds)]);
  const items = rows.map(({ approval, requesterName, requesterRole }) => {
    const decider = approval.approvedBy ?? payloadOf(approval.payload).rejectedBy;
    return toView(approval, { name: requesterName, role: requesterRole }, decider ? (names.get(decider) ?? null) : null, session);
  });
  if (options.status === "pending") return items.filter((item) => item.status === "pending");
  if (options.status === "resolved") return items.filter((item) => item.status !== "pending");
  return items;
}

/** Pending, unexpired requests (all for the owner, own for staff) for the nav badge. */
export async function countPendingApprovals(session: SessionContext): Promise<number> {
  await requirePermission(session, "approvals.view");
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(approvals)
    .where(
      and(
        eq(approvals.shopId, session.shopId),
        session.role === "owner" ? undefined : eq(approvals.requestedBy, session.userId),
        sql`${approvals.usedAt} is null`,
        sql`${approvals.approvedBy} is null`,
        sql`${approvals.expiresAt} > now()`,
        sql`coalesce(${approvals.payload}->>'status', 'pending') = 'pending'`,
      ),
    );
  return row?.count ?? 0;
}
