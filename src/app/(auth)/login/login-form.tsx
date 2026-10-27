"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { CircleAlert, Info, LoaderCircle } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { loginAction, type LoginState } from "./actions";

const initialState: LoginState = { step: "phone", phone: "" };

function SubmitButton({ intent, children, disabled }: { intent: string; children: React.ReactNode; disabled?: boolean }) {
  const { pending, data } = useFormStatus();
  const busy = pending && data?.get("intent") === intent;
  return (
    <Button type="submit" name="intent" value={intent} size="touch" className="w-full" disabled={pending || disabled}>
      {busy ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
      {children}
    </Button>
  );
}

function useSecondsUntil(timestamp?: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!timestamp) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [timestamp]);
  return timestamp ? Math.max(0, Math.ceil((timestamp - now) / 1000)) : 0;
}

export function LoginForm({ showDevHint, demo, setupDone }: { showDevHint: boolean; demo: boolean; setupDone: boolean }) {
  const [state, formAction] = useActionState(loginAction, initialState);
  const resendIn = useSecondsUntil(state.resendAt);
  const needsNewCode = state.reason === "expired" || state.reason === "too_many_attempts" || state.reason === "no_active_code";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">Sign in</h2>
        <p className="text-muted-foreground">
          {state.step === "phone" ? "Enter your mobile number. We'll send you a 6-digit code." : `Enter the code sent to ••••••${state.phone.slice(-4)}.`}
        </p>
      </div>

      {setupDone && state.step === "phone" ? (
        <p role="status" className="rounded-xl bg-success-soft px-4 py-3 text-sm text-success">
          Your shop is set up. Sign in with the owner&apos;s mobile number.
        </p>
      ) : null}

      <form action={formAction} className="flex flex-col gap-4" noValidate>
        {state.step === "phone" ? (
          <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
            Mobile number
            <div className="flex gap-2">
              <span className="grid h-11 w-16 shrink-0 place-items-center rounded-lg border border-input bg-muted text-sm text-muted-foreground">+91</span>
              <Input
                name="phone"
                type="tel"
                inputMode="numeric"
                autoComplete="tel-national"
                maxLength={10}
                defaultValue={state.phone}
                placeholder="98290 12345"
                required
                autoFocus
                aria-invalid={state.error ? true : undefined}
                aria-describedby={state.error ? "login-error" : undefined}
                className="h-11 text-base"
              />
            </div>
          </label>
        ) : (
          <>
            <input type="hidden" name="phone" value={state.phone} />
            {state.notice ? (
              <p role="status" className="flex gap-2 rounded-xl bg-teal-soft px-4 py-3 text-sm text-teal-strong">
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {state.notice}
              </p>
            ) : null}
            <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
              6-digit code
              <Input
                key={state.resendAt}
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="••••••"
                autoFocus
                aria-invalid={state.error ? true : undefined}
                aria-describedby={state.error ? "login-error" : undefined}
                className="h-12 text-center text-xl tracking-[0.5em] tabular-nums"
              />
            </label>
          </>
        )}

        {state.error ? (
          <p id="login-error" role="alert" className="flex gap-2 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{state.error}</span>
          </p>
        ) : null}

        {state.step === "phone" ? (
          <SubmitButton intent="request" disabled={resendIn > 0}>
            {resendIn > 0 ? `Try again in ${resendIn}s` : "Send code"}
          </SubmitButton>
        ) : (
          <div className="flex flex-col gap-2">
            {needsNewCode ? null : <SubmitButton intent="verify">Sign in</SubmitButton>}
            <Button
              type="submit"
              name="intent"
              value="request"
              variant={needsNewCode ? "default" : "outline"}
              size="touch"
              className="w-full"
              disabled={resendIn > 0}
            >
              {resendIn > 0 ? `Send a new code in ${resendIn}s` : "Send a new code"}
            </Button>
            <button
              type="submit"
              name="intent"
              value="change-number"
              className={cn("min-h-11 rounded-lg text-sm font-medium text-teal-strong hover:underline")}
            >
              Use a different number
            </button>
          </div>
        )}
      </form>

      {demo ? (
        <div className="rounded-xl border border-dashed border-amber/60 bg-amber-soft px-4 py-3 text-xs text-amber-ink">
          <p className="font-semibold">Demo with sample data. The sign-in code is shown on screen.</p>
          <p className="mt-1">
            Try owner <span className="font-mono">9000000001</span>, manager <span className="font-mono">9000000002</span>, cashier <span className="font-mono">9000000003</span> or stock <span className="font-mono">9000000005</span>.
          </p>
        </div>
      ) : null}
      {showDevHint ? (
        <p className="rounded-xl border border-dashed border-amber/60 bg-amber-soft px-4 py-3 text-xs text-amber-ink">
          Development mode: codes are printed in the terminal running <code className="font-mono">npm run dev</code>, not sent by SMS.
        </p>
      ) : null}
    </div>
  );
}
