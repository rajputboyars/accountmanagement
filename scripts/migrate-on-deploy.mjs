// Runs database migrations as part of a production deploy, before the new build starts serving
// (handoff §5: forward-only migrations, applied before new code). Preview and local builds skip it
// unless MIGRATE_ON_BUILD=true, so a preview can never migrate the production database by accident.
// Needs DATABASE_MIGRATION_URL (schema-owner role); never prints the connection string.
import { spawnSync } from "node:child_process";

const production = process.env.VERCEL_ENV === "production" || process.env.MIGRATE_ON_BUILD === "true";
if (!production) {
  console.log("[deploy] Not a production deploy: skipping migrations.");
  process.exit(0);
}
if (!process.env.DATABASE_MIGRATION_URL) {
  console.error("[deploy] DATABASE_MIGRATION_URL is not set; refusing to build without applying migrations.");
  process.exit(1);
}
let host = "unknown";
try {
  host = new URL(process.env.DATABASE_MIGRATION_URL).hostname;
} catch {
  console.error("[deploy] DATABASE_MIGRATION_URL is not a valid URL.");
  process.exit(1);
}
console.log(`[deploy] Applying migrations on ${host}…`);
const result = spawnSync("npx", ["drizzle-kit", "migrate"], { stdio: "inherit", shell: process.platform === "win32" });
if (result.status !== 0) {
  console.error("[deploy] Migrations failed; the build stops and the current deployment keeps serving.");
  process.exit(result.status ?? 1);
}
console.log("[deploy] Migrations applied.");
