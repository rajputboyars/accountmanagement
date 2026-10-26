import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb, type Transaction } from "@/server/db";
import { randomToken, sha256Hex } from "@/server/crypto";
import type { RoleName } from "@/shared/permissions";
import { sessions, users } from "./schema";

/** Counter staff sessions last one shift; the owner's phone stays signed in longer (handoff §6). */
export const SESSION_TTL_SECONDS: Record<RoleName, number> = {
  owner: 30 * 24 * 60 * 60,
  manager: 12 * 60 * 60,
  cashier: 12 * 60 * 60,
  inventory: 12 * 60 * 60,
};

/** What the server knows about the signed-in user. Built only from a validated session row. */
export type SessionContext = {
  sessionId: string;
  userId: string;
  shopId: string;
  role: RoleName;
  name: string;
  expiresAt: Date;
};

/**
 * Creates a new session and returns the raw token (shown to the browser once, in a cookie).
 * Only the token's SHA-256 hash is stored, so a database leak cannot be replayed as a cookie.
 */
export async function createSession(
  tx: Transaction,
  user: { id: string; role: RoleName },
  options: { deviceId?: string | null; now?: Date } = {},
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const now = options.now ?? new Date();
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS[user.role] * 1000);
  const [row] = await tx
    .insert(sessions)
    .values({ userId: user.id, deviceId: options.deviceId ?? null, tokenHash: sha256Hex(token), expiresAt })
    .returning({ id: sessions.id });
  return { token, sessionId: row!.id, expiresAt };
}

/** Returns the session for a raw token, or null if unknown, expired, revoked, or the user is inactive. */
export async function validateSessionToken(token: string | undefined | null): Promise<SessionContext | null> {
  if (!token || token.length < 32 || token.length > 128) return null;
  const [row] = await getDb()
    .select({
      sessionId: sessions.id,
      userId: users.id,
      shopId: users.shopId,
      role: users.role,
      name: users.name,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, sha256Hex(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, sql`now()`),
        eq(users.isActive, true),
      ),
    )
    .limit(1);
  return row ? { ...row, role: row.role as RoleName } : null;
}

export async function revokeSessionByToken(tx: Transaction, token: string): Promise<{ sessionId: string; userId: string } | null> {
  const [row] = await tx
    .update(sessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(sessions.tokenHash, sha256Hex(token)), isNull(sessions.revokedAt)))
    .returning({ sessionId: sessions.id, userId: sessions.userId });
  return row ?? null;
}

export async function revokeAllSessionsForUser(tx: Transaction, userId: string): Promise<number> {
  const rows = await tx
    .update(sessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return rows.length;
}
