import { z } from "zod";

/**
 * Database environment, validated on first use (not at import), so pages that never touch the
 * database still build and render without DATABASE_URL. Values are never logged.
 */
const postgresUrl = z
  .string({ error: "DATABASE_URL is not set. Copy .env.example to .env and fill in your local database." })
  .min(1, "DATABASE_URL is empty.")
  .refine((value) => /^postgres(ql)?:\/\//.test(value), "DATABASE_URL must start with postgres:// or postgresql://");

const dbEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: postgresUrl,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
});

export type DbEnv = z.infer<typeof dbEnvSchema>;

let cached: DbEnv | undefined;

export function getDbEnv(source: NodeJS.ProcessEnv = process.env): DbEnv {
  if (cached && source === process.env) return cached;
  const parsed = dbEnvSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `- ${issue.path.join(".") || "env"}: ${issue.message}`).join("\n");
    throw new Error(`Invalid database environment:\n${problems}`);
  }
  if (source === process.env) cached = parsed.data;
  return parsed.data;
}

/** Host part of a connection string, for safety checks. Never returns credentials. */
export function databaseHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function isLocalDatabase(url: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(databaseHost(url));
}
