import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

// Load .env with Node's built-in loader (no dotenv dependency). Real values never live in the repo.
if (existsSync(".env")) process.loadEnvFile(".env");

// Migrations run as the schema owner role; fall back to DATABASE_URL for a single-role local setup.
const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL ?? "";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/modules/*/schema.ts",
  out: "./db/migrations",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
