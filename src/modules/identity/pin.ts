import { hash, verify, type Algorithm } from "@node-rs/argon2";
import { and, eq, sql } from "drizzle-orm";
import { countRecentFailures, recordAudit } from "@/modules/audit";
import { getDb, withTransaction } from "@/server/db";
import { ConflictError, ForbiddenError, RateLimitedError, ValidationError } from "@/server/errors";
import type { SessionContext } from "./sessions";
import { users } from "./schema";

/** OWASP-recommended Argon2id parameters (19 MiB, 2 iterations, 1 lane). */
// Algorithm is an ambient const enum (not importable under isolatedModules); 2 = Argon2id.
const ARGON2ID = 2 as Algorithm;
const ARGON2_OPTIONS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PIN_MAX_FAILURES = 5;
export const PIN_LOCKOUT_SECONDS = 15 * 60;

export function validatePinStrength(pin: string): void {
  if (!/^\d{4,6}$/.test(pin)) throw new ValidationError("The PIN must be 4 to 6 digits.");
  const digits = pin.split("").map(Number);
  const allSame = digits.every((d) => d === digits[0]);
  const ascending = digits.every((d, i) => i === 0 || d === (digits[i - 1]! + 1) % 10);
  const descending = digits.every((d, i) => i === 0 || d === (digits[i - 1]! + 9) % 10);
  if (allSame || ascending || descending) {
    throw new ValidationError("Choose a PIN that is harder to guess (not 1111 or 1234).");
  }
}

export function hashPin(pin: string): Promise<string> {
  return hash(pin, ARGON2_OPTIONS);
}

/** Whether the shop's owner has set an approval PIN. Never returns the hash. */
export async function isOwnerPinSet(session: Pick<SessionContext, "shopId">): Promise<boolean> {
  const [owner] = await getDb()
    .select({ pinSet: sql<boolean>`${users.pinHash} is not null` })
    .from(users)
    .where(and(eq(users.shopId, session.shopId), eq(users.role, "owner")))
    .limit(1);
  return owner?.pinSet === true;
}

/** Owner only: sets or replaces the approval PIN. Only the Argon2id hash is stored. */
export async function setOwnerPin(session: SessionContext, pin: string): Promise<void> {
  if (session.role !== "owner") throw new ForbiddenError("Only the owner can set the approval PIN.");
  validatePinStrength(pin);
  const pinHash = await hashPin(pin);
  await withTransaction(async (tx) => {
    const updated = await tx
      .update(users)
      .set({ pinHash })
      .where(and(eq(users.id, session.userId), eq(users.shopId, session.shopId), eq(users.role, "owner")))
      .returning({ id: users.id });
    if (updated.length !== 1) throw new ForbiddenError("Only the owner can set the approval PIN.");
    await recordAudit(tx, { shopId: session.shopId, userId: session.userId, role: session.role }, {
      action: "identity.pin_set",
      entityType: "user",
      entityId: session.userId,
    });
  });
}

type PinOutcome = { ok: true } | { ok: false; locked: boolean; attemptsLeft: number };

/**
 * Checks the shop owner's approval PIN (entered on any counter of the same shop).
 * After 5 wrong entries in 15 minutes, verification is locked for the rest of that window.
 * Each attempt is audited (without the PIN) and failures are committed before the error.
 */
export async function verifyOwnerPin(session: Pick<SessionContext, "shopId" | "userId" | "role">, pin: string): Promise<true> {
  const outcome = await withTransaction<PinOutcome>(async (tx) => {
    const [owner] = await tx
      .select({ id: users.id, pinHash: users.pinHash })
      .from(users)
      .where(and(eq(users.shopId, session.shopId), eq(users.role, "owner"), eq(users.isActive, true)))
      .limit(1);
    if (!owner?.pinHash) throw new ConflictError("PIN_NOT_SET", "The owner has not set an approval PIN yet.");

    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"pin:" + owner.id}))`);
    const failures = await countRecentFailures(tx, {
      shopId: session.shopId,
      entityId: owner.id,
      failureAction: "identity.pin_failed",
      resetAction: "identity.pin_verified",
      windowSeconds: PIN_LOCKOUT_SECONDS,
    });
    if (failures >= PIN_MAX_FAILURES) return { ok: false, locked: true, attemptsLeft: 0 };

    const actor = { shopId: session.shopId, userId: session.userId, role: session.role };
    const valid = /^\d{4,6}$/.test(pin) && (await verify(owner.pinHash, pin));
    await recordAudit(tx, actor, {
      action: valid ? "identity.pin_verified" : "identity.pin_failed",
      entityType: "user",
      entityId: owner.id,
    });
    if (valid) return { ok: true };
    const attemptsLeft = PIN_MAX_FAILURES - (failures + 1);
    return { ok: false, locked: attemptsLeft <= 0, attemptsLeft: Math.max(0, attemptsLeft) };
  });

  if (outcome.ok) return true;
  if (outcome.locked) throw new RateLimitedError("Too many wrong PIN entries. Approvals are locked for 15 minutes.", PIN_LOCKOUT_SECONDS);
  throw new ValidationError(`Wrong PIN. ${outcome.attemptsLeft} attempts left.`, { attemptsLeft: outcome.attemptsLeft });
}
