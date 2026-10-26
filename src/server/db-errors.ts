/**
 * PostgreSQL error inspection. Drizzle wraps driver errors ("Failed query: …") and keeps the
 * original pg error in `cause`; this looks at both so callers can map constraint failures to
 * friendly messages without exposing SQL or internals to the browser.
 */
type PgErrorLike = { code?: string; constraint?: string };

function pgError(error: unknown): PgErrorLike | null {
  if (!error || typeof error !== "object") return null;
  const direct = error as PgErrorLike & { cause?: unknown };
  if (direct.code) return direct;
  const cause = direct.cause as PgErrorLike | undefined;
  return cause && typeof cause === "object" && cause.code ? cause : null;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = pgError(error);
  return pg?.code === "23505" && (!constraint || pg.constraint === constraint);
}

export function isForeignKeyViolation(error: unknown, constraint?: string): boolean {
  const pg = pgError(error);
  return pg?.code === "23503" && (!constraint || pg.constraint === constraint);
}
