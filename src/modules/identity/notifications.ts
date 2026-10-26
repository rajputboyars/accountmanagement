import { and, eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import { maskPhone } from "./otp-provider";
import { users } from "./schema";

/**
 * Approval alerts. Nexora has no SMS/WhatsApp provider for staff alerts (the OTP sender only sends
 * sign-in codes on an approved template, and the reminder boundary is for customers), so alerts are
 * in-app: the request waits in the Approvals inbox and the nav badge counts it. Nothing here claims an
 * external delivery. When a provider is added, send from here and set `delivered` only on success.
 */
export type NotificationResult = { delivered: boolean; channel: "in_app"; note: string };

export async function notifyApprovalEvent(
  shopId: string,
  event:
    | { type: "requested"; requesterName: string; actionLabel: string; targetLabel: string }
    | { type: "decided"; recipientUserId: string; actionLabel: string; targetLabel: string; decision: "approved" | "rejected"; decisionReason: string | null },
): Promise<NotificationResult> {
  const [recipient] = await getDb()
    .select({ name: users.name, phone: users.phone })
    .from(users)
    .where(and(eq(users.shopId, shopId), eq(users.isActive, true), event.type === "requested" ? eq(users.role, "owner") : eq(users.id, event.recipientUserId)))
    .limit(1);
  const note =
    event.type === "requested"
      ? "No SMS or WhatsApp service is set up for staff alerts. The owner will see this request in Approvals."
      : `The requester will see the ${event.decision === "approved" ? "approval" : "rejection"} in Approvals.`;
  if (recipient) console.info(`[nexora approvals] in-app alert for ${recipient.name} (${maskPhone(recipient.phone)}): ${event.actionLabel} · ${event.targetLabel}${event.type === "decided" ? ` · ${event.decision}` : ""}`);
  return { delivered: false, channel: "in_app", note };
}
