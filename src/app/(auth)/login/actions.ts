"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { requestSignInCode, SignInError, signInWithCode, signOut, type SignInFailure } from "@/modules/identity";
import { toActionError } from "@/server/action-result";
import { clearSessionCookie, homePathForRole, readSessionToken, setSessionCookie } from "@/server/auth";

export type LoginState = {
  step: "phone" | "code";
  phone: string;
  /** Epoch ms when "Send again" becomes available. */
  resendAt?: number;
  notice?: string;
  error?: string;
  reason?: SignInFailure | "rate_limited" | "validation" | "unavailable";
};

const digits = (value: FormDataEntryValue | null) => String(value ?? "").replace(/\D/g, "");

export async function loginAction(previous: LoginState, formData: FormData): Promise<LoginState> {
  const intent = formData.get("intent");
  const phone = digits(formData.get("phone")).slice(-10) || previous.phone;

  if (intent === "change-number") return { step: "phone", phone };

  if (intent === "request") {
    try {
      const { resendAfterSeconds } = await requestSignInCode({ phone });
      return {
        step: "code",
        phone,
        resendAt: Date.now() + resendAfterSeconds * 1000,
        notice: "If this number belongs to a staff account, we've sent a 6-digit code. It works for 5 minutes.",
      };
    } catch (error) {
      unstable_rethrow(error);
      const failure = toActionError(error);
      const retryAfter = Number(failure.details?.retryAfterSeconds ?? 0);
      return {
        ...previous,
        phone,
        error: failure.error,
        reason: failure.code === "RATE_LIMITED" ? "rate_limited" : failure.code === "CONFIGURATION" ? "unavailable" : "validation",
        resendAt: retryAfter ? Date.now() + retryAfter * 1000 : previous.resendAt,
      };
    }
  }

  if (intent === "verify") {
    let destination: string;
    try {
      const result = await signInWithCode({ phone, code: digits(formData.get("code")) });
      // Never reuse a pre-existing session: revoke whatever cookie came in, then set the new token.
      await signOut(await readSessionToken());
      await setSessionCookie(result.token, result.expiresAt);
      destination = homePathForRole(result.user.role);
    } catch (error) {
      unstable_rethrow(error);
      if (error instanceof SignInError) return { ...previous, step: "code", phone, error: error.message, reason: error.reason, notice: undefined };
      return { ...previous, step: "code", phone, error: toActionError(error).error, reason: "validation", notice: undefined };
    }
    redirect(destination);
  }

  return previous;
}

export async function signOutAction(): Promise<void> {
  await signOut(await readSessionToken());
  await clearSessionCookie();
  redirect("/login");
}
