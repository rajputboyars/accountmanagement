import { and, eq, sql } from "drizzle-orm";
import type { Transaction } from "@/server/db";
import { sha256Hex } from "@/server/crypto";
import { ConflictError, ValidationError } from "@/server/errors";
import { idempotencyKeys } from "./schema";

export type IdempotentResult<T> = { status: number; body: T };
export type IdempotencyOutcome<T> = IdempotentResult<T> & { replayed: boolean };

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
/** Placeholder status while the first request's transaction is still running. */
const IN_PROGRESS = 0;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Stable hash of a request body: key order does not matter. */
export function hashRequest(body: unknown): string {
  return sha256Hex(JSON.stringify(canonicalize(body ?? null)));
}

/**
 * Runs `operation` at most once per (shop, Idempotency-Key), inside the caller's transaction.
 *
 * - First request: claims the key, runs the operation, stores its response; all in one transaction.
 *   If the operation throws, the transaction (and the claim) rolls back, so a retry runs again.
 * - Concurrent duplicate: PostgreSQL makes the second INSERT wait on the unique key until the
 *   first transaction finishes; it then sees the committed response and returns it (replayed).
 * - Same key with a different body, or from a different user: 409 IDEMPOTENCY_CONFLICT.
 *
 * Only operations that actually call this helper are idempotent.
 */
export async function withIdempotency<T>(
  tx: Transaction,
  scope: { shopId: string; userId: string; key: string },
  requestBody: unknown,
  operation: () => Promise<IdempotentResult<T>>,
): Promise<IdempotencyOutcome<T>> {
  if (!KEY_PATTERN.test(scope.key)) {
    throw new ValidationError("Idempotency-Key must be 8–128 letters, digits, '-' or '_'.");
  }
  const requestHash = hashRequest(requestBody);

  const claimed = await tx
    .insert(idempotencyKeys)
    .values({ shopId: scope.shopId, key: scope.key, userId: scope.userId, requestHash, response: sql`'null'::jsonb`, statusCode: IN_PROGRESS })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });

  if (claimed.length === 1) {
    const result = await operation();
    await tx
      .update(idempotencyKeys)
      .set({ response: result.body as unknown, statusCode: result.status })
      .where(and(eq(idempotencyKeys.shopId, scope.shopId), eq(idempotencyKeys.key, scope.key)));
    return { ...result, replayed: false };
  }

  const [existing] = await tx
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.shopId, scope.shopId), eq(idempotencyKeys.key, scope.key)));

  if (!existing || existing.statusCode === IN_PROGRESS) {
    throw new ConflictError("IDEMPOTENCY_IN_PROGRESS", "This request is still being processed. Try again in a moment.");
  }
  if (existing.userId !== scope.userId || existing.requestHash !== requestHash) {
    throw new ConflictError("IDEMPOTENCY_CONFLICT", "This Idempotency-Key was already used for a different request.");
  }
  return { status: existing.statusCode, body: existing.response as T, replayed: true };
}
