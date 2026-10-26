import { ZodError } from "zod";
import { isAppError } from "./errors";

export type ActionError = { ok: false; error: string; code?: string; details?: Record<string, unknown> };

/** Turns any thrown error into a message safe to show staff. Unexpected errors are logged without details. */
export function toActionError(error: unknown): ActionError {
  if (error instanceof ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? "Please check the form.", code: "VALIDATION" };
  }
  if (isAppError(error)) {
    return { ok: false, error: error.message, code: error.code, details: error.details };
  }
  console.error("[action] unexpected error:", error instanceof Error ? error.name : typeof error);
  return { ok: false, error: "Something went wrong. Please try again.", code: "INTERNAL" };
}
