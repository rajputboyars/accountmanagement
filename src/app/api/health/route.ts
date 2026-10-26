import { sql } from "drizzle-orm";
import { connection } from "next/server";
import journal from "../../../../db/migrations/meta/_journal.json";
import { getDb } from "@/server/db";

/**
 * Health check for the host / uptime monitor: GET /api/health → 200 when the database answers and
 * every migration shipped with this build is applied, otherwise 503. No session needed (excluded from
 * the proxy); it reveals nothing beyond up/down, migration state and the short commit id.
 */
const EXPECTED_MIGRATIONS = journal.entries.length;

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

export async function GET() {
  await connection(); // always run at request time, never pre-rendered at build
  let database: "ok" | "down" = "down";
  let migrations: "current" | "pending" | "unknown" = "unknown";
  try {
    await withTimeout(getDb().execute(sql`select 1`), 3000);
    database = "ok";
    try {
      const result = await withTimeout(getDb().execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`), 3000);
      migrations = (result.rows[0]?.n ?? 0) >= EXPECTED_MIGRATIONS ? "current" : "pending";
    } catch {
      migrations = "unknown"; // the app role may not read the migrations table; the database itself is fine
    }
  } catch {
    console.error(JSON.stringify({ level: "error", event: "health_db_down" }));
  }
  const ok = database === "ok" && migrations !== "pending";
  return Response.json(
    { status: ok ? "ok" : "degraded", database, migrations, version: (process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.APP_VERSION ?? "dev").slice(0, 12) },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
