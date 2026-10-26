import { z } from "zod";

/**
 * Environment validation. Each group is validated on first use (not at import), so pages that
 * never touch the database or auth still build and render. Values are never logged.
 */

const nodeEnv = z.enum(["development", "test", "production"]).default("development");

const postgresUrl = z
  .string({ error: "DATABASE_URL is not set. Copy .env.example to .env and fill in your local database." })
  .min(1, "DATABASE_URL is empty.")
  .refine((value) => /^postgres(ql)?:\/\//.test(value), "DATABASE_URL must start with postgres:// or postgresql://");

const dbEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  DATABASE_URL: postgresUrl,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
});

const authEnvSchema = z
  .object({
    NODE_ENV: nodeEnv,
    OTP_PEPPER: z
      .string({ error: "OTP_PEPPER is not set. Generate one with: npm run secret" })
      .min(32, "OTP_PEPPER must be at least 32 characters (use npm run secret)."),
    // Optional: when absent, first-run setup is disabled (never open by default).
    SETUP_TOKEN: z
      .string()
      .min(32, "SETUP_TOKEN must be at least 32 characters (use npm run secret).")
      .optional()
      .or(z.literal("").transform(() => undefined)),
    SESSION_COOKIE_NAME: z
      .string()
      .regex(/^[a-z_]{3,32}$/, "SESSION_COOKIE_NAME may only use lowercase letters and _")
      .default("nx_session"),
    SMS_PROVIDER: z.enum(["console", "msg91"]).default("console"),
    // MSG91 (DLT-registered OTP template). Required when SMS_PROVIDER=msg91.
    MSG91_AUTH_KEY: z.string().trim().optional(),
    MSG91_TEMPLATE_ID: z.string().trim().optional(),
    MSG91_OTP_VARIABLE: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]{0,30}$/, "MSG91_OTP_VARIABLE must be a template variable name.").default("otp"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && env.SMS_PROVIDER === "console") {
      ctx.addIssue({ code: "custom", path: ["SMS_PROVIDER"], message: "The console OTP provider is not allowed in production." });
    }
    if (env.SMS_PROVIDER === "msg91") {
      if (!env.MSG91_AUTH_KEY || env.MSG91_AUTH_KEY.length < 16) ctx.addIssue({ code: "custom", path: ["MSG91_AUTH_KEY"], message: "MSG91_AUTH_KEY is not set." });
      if (!env.MSG91_TEMPLATE_ID) ctx.addIssue({ code: "custom", path: ["MSG91_TEMPLATE_ID"], message: "MSG91_TEMPLATE_ID (the DLT-approved OTP template) is not set." });
    }
  });

export type DbEnv = z.infer<typeof dbEnvSchema>;
export type AuthEnv = z.infer<typeof authEnvSchema>;

function parse<T>(schema: z.ZodType<T>, source: NodeJS.ProcessEnv, label: string): T {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `- ${issue.path.join(".") || "env"}: ${issue.message}`).join("\n");
    throw new Error(`Invalid ${label} environment:\n${problems}`);
  }
  return parsed.data;
}

export function getDbEnv(source: NodeJS.ProcessEnv = process.env): DbEnv {
  return parse(dbEnvSchema, source, "database");
}

export function getAuthEnv(source: NodeJS.ProcessEnv = process.env): AuthEnv {
  return parse(authEnvSchema, source, "authentication");
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
