import { and, count, eq, gt, sql } from "drizzle-orm";
import type { Database, Transaction } from "@/server/db";
import { auditLog } from "./schema";

export type AuditActor = {
  shopId: string;
  userId?: string | null;
  role?: string | null;
  deviceId?: string | null;
};

export type AuditEvent = {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  approvalId?: string | null;
  offline?: boolean;
  ip?: string | null;
};

const REDACTED = "[redacted]";
const SECRET_KEYS = new Set(["otp", "code", "otpcode", "token", "pin", "password", "secret", "pepper", "cookie", "authorization", "setuptoken"]);
const SECRET_SUFFIXES = ["token", "hash", "secret", "password", "pin", "pepper"];

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
  return SECRET_KEYS.has(normalized) || SECRET_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/** Deep copy with secrets (OTPs, tokens, PINs, hashes, passwords) replaced by "[redacted]". */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? REDACTED : redact(item, depth + 1);
  }
  return out;
}

/**
 * Writes one audit row inside the caller's transaction, so the audit entry commits or rolls
 * back together with the change it describes. `before`/`after` are redacted before storage.
 */
export async function recordAudit(tx: Transaction, actor: AuditActor, event: AuditEvent): Promise<void> {
  await tx.insert(auditLog).values({
    shopId: actor.shopId,
    userId: actor.userId ?? null,
    role: actor.role ?? null,
    deviceId: actor.deviceId ?? null,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    before: event.before === undefined ? null : redact(event.before),
    after: event.after === undefined ? null : redact(event.after),
    reason: event.reason ?? null,
    approvalId: event.approvalId ?? null,
    offline: event.offline ?? false,
    ip: event.ip ?? null,
  });
}

/**
 * Number of `failureAction` events for an entity in the last `windowSeconds`, counting only those
 * after the most recent `resetAction` (for example a successful PIN entry). Used for lockouts.
 */
export async function countRecentFailures(
  db: Database | Transaction,
  input: { shopId: string; entityId: string; failureAction: string; resetAction: string; windowSeconds: number },
): Promise<number> {
  const lastReset = sql`coalesce((select max(${auditLog.at}) from ${auditLog} where ${auditLog.shopId} = ${input.shopId} and ${auditLog.entityId} = ${input.entityId} and ${auditLog.action} = ${input.resetAction}), '-infinity'::timestamptz)`;
  const [row] = await db
    .select({ failures: count() })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.shopId, input.shopId),
        eq(auditLog.entityId, input.entityId),
        eq(auditLog.action, input.failureAction),
        gt(auditLog.at, sql`greatest(now() - make_interval(secs => ${input.windowSeconds}), ${lastReset})`),
      ),
    );
  return row?.failures ?? 0;
}
