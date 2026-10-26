import { getAuthEnv } from "@/server/env";
import { ConfigurationError } from "@/server/errors";

/**
 * Delivers sign-in codes. Implementations must never log the code in production.
 * A real SMS provider (an Indian DLT-registered sender, e.g. MSG91) implements this interface.
 */
export interface OtpSender {
  readonly name: string;
  send(message: { phone: string; code: string }): Promise<void>;
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

export function getOtpSender(): OtpSender {
  const env = getAuthEnv();
  switch (env.SMS_PROVIDER) {
    case "console":
      return new ConsoleOtpSender();
    case "msg91":
      throw new ConfigurationError("SMS_PROVIDER=msg91 is not implemented yet. Sign-in codes cannot be sent.");
  }
}
