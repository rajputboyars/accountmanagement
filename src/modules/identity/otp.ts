import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/modules/audit";
import { withTransaction } from "@/server/db";
import { hmacSha256Hex, randomOtpCode, safeEqual } from "@/server/crypto";
import { getAuthEnv } from "@/server/env";
import { ConflictError, RateLimitedError, ValidationError } from "@/server/errors";
import type { RoleName } from "@/shared/permissions";
import { getOtpSender, type OtpSender } from "./otp-provider";
import { createSession } from "./sessions";
import { otpRequests, users } from "./schema";

export const OTP_TTL_SECONDS = 5 * 60;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_REQUESTS_PER_HOUR = 5;
export const OTP_RESEND_COOLDOWN_SECONDS = 30;

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^[6-9]\d{9}$/, "Enter a 10-digit Indian mobile number.");
const codeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter the 6-digit code.");

function codeHash(phone: string, code: string): string {
  return hmacSha256Hex(getAuthEnv().OTP_PEPPER, `${phone}:${code}`);
}

/** Serialises OTP work for one phone number inside a transaction. */
const lockPhone = (phone: string) => sql`select pg_advisory_xact_lock(hashtext(${"otp:" + phone}))`;

/**
 * Sends a sign-in code. The response is the same whether or not the number belongs to a user,
 * so the form cannot be used to discover staff numbers. Limits: one code every 30 s and five
 * per hour per number. Requesting a new code invalidates older unused codes.
 */
export async function requestSignInCode(
  input: { phone: string },
  deps: { sender?: OtpSender } = {},
): Promise<{ resendAfterSeconds: number }> {
  const phone = phoneSchema.parse(input.phone);
  const sender = deps.sender ?? getOtpSender();

  const code = await withTransaction(async (tx) => {
    await tx.execute(lockPhone(phone));
    const [known] = await tx.select({ id: users.id }).from(users).where(and(eq(users.phone, phone), eq(users.isActive, true))).limit(1);
    if (!known) return null;

    const [recent] = await tx
      .select({ total: count(), latest: sql<Date | null>`max(${otpRequests.createdAt})` })
      .from(otpRequests)
      .where(and(eq(otpRequests.phone, phone), gt(otpRequests.createdAt, sql`now() - interval '1 hour'`)));
    const latest = recent?.latest ? new Date(recent.latest) : null;
    if (latest && Date.now() - latest.getTime() < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
      const wait = Math.ceil((OTP_RESEND_COOLDOWN_SECONDS * 1000 - (Date.now() - latest.getTime())) / 1000);
      throw new RateLimitedError(`Please wait ${wait} seconds before asking for another code.`, wait);
    }
    if ((recent?.total ?? 0) >= OTP_MAX_REQUESTS_PER_HOUR) {
      throw new RateLimitedError("Too many codes requested for this number. Try again in an hour.", 3600);
    }

    await tx
      .update(otpRequests)
      .set({ consumedAt: sql`now()` })
      .where(and(eq(otpRequests.phone, phone), isNull(otpRequests.consumedAt)));
    const newCode = randomOtpCode();
    await tx.insert(otpRequests).values({
      phone,
      codeHash: codeHash(phone, newCode),
      expiresAt: sql`now() + make_interval(secs => ${OTP_TTL_SECONDS})`,
    });
    return newCode;
  });

  // Sent after commit, so a code is never delivered for a request that did not persist.
  if (code) await sender.send({ phone, code });
  return { resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS };
}

export type SignInFailure = "invalid_code" | "expired" | "too_many_attempts" | "no_active_code";

export class SignInError extends ValidationError {
  constructor(
    readonly reason: SignInFailure,
    message: string,
    readonly attemptsLeft?: number,
  ) {
    super(message, { reason, attemptsLeft });
  }
}

const FAILURE_MESSAGES: Record<SignInFailure, string> = {
  invalid_code: "That code is not right.",
  expired: "This code has expired. Ask for a new one.",
  too_many_attempts: "Too many wrong attempts. Ask for a new code.",
  no_active_code: "No active code for this number. Ask for a new one.",
};

type VerifyOutcome =
  | { ok: true; token: string; expiresAt: Date; user: { id: string; shopId: string; role: RoleName; name: string } }
  | { ok: false; reason: SignInFailure; attemptsLeft?: number };

/**
 * Verifies a code and, in the same transaction, consumes it and creates a new session.
 * The OTP row is locked FOR UPDATE, so a code can be used once even under concurrent requests.
 * Wrong attempts are counted (and committed) before the error is returned.
 */
export async function signInWithCode(input: { phone: string; code: string }): Promise<{
  token: string;
  expiresAt: Date;
  user: { id: string; shopId: string; role: RoleName; name: string };
}> {
  const phone = phoneSchema.parse(input.phone);
  const code = codeSchema.parse(input.code);

  const outcome = await withTransaction<VerifyOutcome>(async (tx) => {
    const [otp] = await tx
      .select()
      .from(otpRequests)
      .where(and(eq(otpRequests.phone, phone), isNull(otpRequests.consumedAt)))
      .orderBy(desc(otpRequests.createdAt))
      .limit(1)
      .for("update");

    if (!otp) return { ok: false, reason: "no_active_code" };
    if (otp.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };
    if (otp.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };

    if (!safeEqual(otp.codeHash, codeHash(phone, code))) {
      const attempts = otp.attempts + 1;
      await tx.update(otpRequests).set({ attempts }).where(eq(otpRequests.id, otp.id));
      return attempts >= OTP_MAX_ATTEMPTS
        ? { ok: false, reason: "too_many_attempts" }
        : { ok: false, reason: "invalid_code", attemptsLeft: OTP_MAX_ATTEMPTS - attempts };
    }

    await tx.update(otpRequests).set({ consumedAt: sql`now()` }).where(eq(otpRequests.id, otp.id));

    const matches = await tx
      .select({ id: users.id, shopId: users.shopId, role: users.role, name: users.name })
      .from(users)
      .where(and(eq(users.phone, phone), eq(users.isActive, true)))
      .limit(2);
    if (matches.length !== 1) {
      if (matches.length > 1) {
        throw new ConflictError("MULTIPLE_ACCOUNTS", "This number belongs to more than one shop. Contact support.");
      }
      return { ok: false, reason: "no_active_code" };
    }
    const user = { ...matches[0]!, role: matches[0]!.role as RoleName };
    const session = await createSession(tx, user);
    await recordAudit(tx, { shopId: user.shopId, userId: user.id, role: user.role }, {
      action: "auth.sign_in",
      entityType: "session",
      entityId: session.sessionId,
      after: { method: "otp", expiresAt: session.expiresAt },
    });
    return { ok: true, token: session.token, expiresAt: session.expiresAt, user };
  });

  if (!outcome.ok) {
    throw new SignInError(outcome.reason, FAILURE_MESSAGES[outcome.reason], outcome.attemptsLeft);
  }
  return outcome;
}
