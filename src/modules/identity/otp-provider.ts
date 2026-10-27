import { getAuthEnv } from "@/server/env";
import { ConfigurationError } from "@/server/errors";

/**
 * Delivers sign-in codes. Implementations must never log the code in production.
 * A real SMS provider (an Indian DLT-registered sender, e.g. MSG91) implements this interface.
 */
export interface OtpSender {
  readonly name: string;
  /** `displayCode` is returned only by the demo sender, to show the code on screen. */
  send(message: { phone: string; code: string }): Promise<void | { displayCode: string }>;
}

export function maskPhone(phone: string): string {
  return phone.length >= 4 ? `${"•".repeat(phone.length - 4)}${phone.slice(-4)}` : "••••";
}

/** Development only: prints the code to the server terminal. Refuses to run in production. */
export class ConsoleOtpSender implements OtpSender {
  readonly name = "console";

  async send({ phone, code }: { phone: string; code: string }): Promise<void> {
    if (process.env.NODE_ENV === "production") {
      throw new ConfigurationError("The console OTP provider cannot be used in production.");
    }
    console.info(`[nexora dev OTP] code for ${maskPhone(phone)}: ${code} (valid 5 minutes)`);
  }
}

/**
 * MSG91 Flow API with a DLT-approved OTP template (Indian SMS rules require registered templates).
 * The code is passed as a template variable and never logged. A failure throws, so sign-in shows
 * "couldn't send the code" instead of pretending it was sent.
 */
export class Msg91OtpSender implements OtpSender {
  readonly name = "msg91";

  constructor(
    private readonly config: { authKey: string; templateId: string; otpVariable: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send({ phone, code }: { phone: string; code: string }): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl("https://control.msg91.com/api/v5/flow", {
        method: "POST",
        headers: { authkey: this.config.authKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ template_id: this.config.templateId, short_url: "0", recipients: [{ mobiles: `91${phone}`, [this.config.otpVariable]: code }] }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ConfigurationError("The SMS service could not be reached. Try again in a minute.");
    }
    const body = (await response.json().catch(() => null)) as { type?: string; message?: string } | null;
    if (!response.ok || body?.type === "error") {
      console.error(`[otp] msg91 refused the code for ${maskPhone(phone)}: ${response.status}`);
      throw new ConfigurationError("The sign-in code couldn't be sent. Try again in a minute.");
    }
  }
}

/**
 * Public demo only (SMS_PROVIDER=demo, allowed only with DEMO_MODE=true): nothing is sent; the code
 * is handed back so the sign-in page can show it. Anyone who knows a staff number can sign in, so the
 * demo must hold sample data only.
 */
export class DemoOtpSender implements OtpSender {
  readonly name = "demo";

  async send({ code }: { phone: string; code: string }): Promise<{ displayCode: string }> {
    return { displayCode: code };
  }
}

export function getOtpSender(): OtpSender {
  const env = getAuthEnv();
  switch (env.SMS_PROVIDER) {
    case "console":
      return new ConsoleOtpSender();
    case "demo":
      return new DemoOtpSender();
    case "msg91":
      return new Msg91OtpSender({ authKey: env.MSG91_AUTH_KEY!, templateId: env.MSG91_TEMPLATE_ID!, otpVariable: env.MSG91_OTP_VARIABLE });
  }
}
