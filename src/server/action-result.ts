import { ZodError } from "zod";
import { isAppError } from "./errors";

export type ActionError = {
  ok: false;
  error: string;
  code?: string;
  details?: Record<string, unknown>;
  /** Validation messages keyed by form field name, for showing next to each field. */
  fieldErrors?: Record<string, string>;
};

/** Turns any thrown error into a message safe to show staff. Unexpected errors are logged without details. */
export function toActionError(error: unknown): ActionError {
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = String(issue.path[0] ?? "");
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, error: error.issues[0]?.message ?? "Please check the form.", code: "VALIDATION", fieldErrors };
  }
  if (isAppError(error)) {
    return { ok: false, error: error.message, code: error.code, details: error.details };
  }
  console.error("[action] unexpected error:", error instanceof Error ? error.name : typeof error);
  return { ok: false, error: "Something went wrong. Please try again.", code: "INTERNAL" };
}
