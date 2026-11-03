import { ZodError } from "zod";
import { isAppError } from "./errors";
import { localizeServerMessage } from "./i18n";

export type ActionError = {
  ok: false;
  error: string;
  code?: string;
  details?: Record<string, unknown>;
  /** Validation messages keyed by form field name, for showing next to each field. */
  fieldErrors?: Record<string, string>;
};

/** Messages meant for one field travel in `details.fieldErrors`. */
async function localizedDetails(details: Record<string, unknown> | undefined) {
  const fieldErrors = details?.fieldErrors as Record<string, string> | undefined;
  if (!fieldErrors) return details;
  const entries = await Promise.all(Object.entries(fieldErrors).map(async ([field, message]) => [field, await localizeServerMessage(message)] as const));
  return { ...details, fieldErrors: Object.fromEntries(entries) };
}

/** Turns any thrown error into a message safe to show staff. Unexpected errors are logged without details. */
export async function toActionError(error: unknown): Promise<ActionError> {
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = String(issue.path[0] ?? "");
      if (key && !fieldErrors[key]) fieldErrors[key] = await localizeServerMessage(issue.message);
    }
    return { ok: false, error: await localizeServerMessage(error.issues[0]?.message ?? "Please check the form."), code: "VALIDATION", fieldErrors };
  }
  if (isAppError(error)) {
    return { ok: false, error: await localizeServerMessage(error.message), code: error.code, details: await localizedDetails(error.details) };
  }
  console.error("[action] unexpected error:", error instanceof Error ? error.name : typeof error);
  return { ok: false, error: await localizeServerMessage("Something went wrong. Please try again."), code: "INTERNAL" };
}
