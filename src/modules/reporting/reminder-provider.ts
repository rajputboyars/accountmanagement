import { createHmac, timingSafeEqual } from "node:crypto";
import { ConfigurationError } from "@/server/errors";

/**
 * WhatsApp provider boundary. `WHATSAPP_PROVIDER` picks one:
 *   - empty / "none": no provider; the app offers Copy / Open WhatsApp only and never claims a send.
 *   - "meta": WhatsApp Business Cloud API. Needs WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID;
 *     WHATSAPP_TEMPLATE_NAME (an approved template with one body variable) is used when set, since
 *     business-initiated messages outside the 24-hour window must be templates; WHATSAPP_TEMPLATE_LANG
 *     (default "en"), WHATSAPP_API_VERSION (default "v21.0"). The status webhook is verified with
 *     WHATSAPP_APP_SECRET (signature) and WHATSAPP_VERIFY_TOKEN (subscription check).
 * Tests pass a fake provider explicitly; nothing in tests reaches the network.
 */

export type SendResult = { providerMessageId: string };

export interface ReminderProvider {
  readonly name: string;
  send(message: { phone: string; text: string }): Promise<SendResult>;
}

/** A failed send. `retryable` = try again later (network, rate limit, 5xx); otherwise give up. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

export function metaCloudProvider(config: { token: string; phoneNumberId: string; templateName?: string; templateLang?: string; apiVersion?: string }, fetchImpl: Fetch = fetch): ReminderProvider {
  const url = `https://graph.facebook.com/${config.apiVersion ?? "v21.0"}/${config.phoneNumberId}/messages`;
  return {
    name: "meta",
    async send({ phone, text }) {
      const to = phone.length === 10 ? `91${phone}` : phone.replace(/^\+/, "");
      const body = config.templateName
        ? { messaging_product: "whatsapp", to, type: "template", template: { name: config.templateName, language: { code: config.templateLang ?? "en" }, components: [{ type: "body", parameters: [{ type: "text", text: text.replace(/\s*\n\s*/g, " · ").slice(0, 1000) }] }] } }
        : { messaging_product: "whatsapp", to, type: "text", text: { body: text.slice(0, 4096), preview_url: false } };
      let response: Response;
      try {
        response = await fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      } catch (error) {
        throw new ProviderError(`WhatsApp could not be reached: ${error instanceof Error ? error.message : "network error"}.`, true);
      }
      const json = (await response.json().catch(() => null)) as { messages?: { id?: string }[]; error?: { message?: string; code?: number } } | null;
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        throw new ProviderError(`WhatsApp refused the message (${response.status}${json?.error?.code ? `/${json.error.code}` : ""}): ${json?.error?.message ?? "no reason given"}.`, retryable);
      }
      const id = json?.messages?.[0]?.id;
      if (!id) throw new ProviderError("WhatsApp accepted the request but returned no message id.", false);
      return { providerMessageId: id };
    },
  };
}

export function getReminderProvider(env: NodeJS.ProcessEnv = process.env): ReminderProvider | null {
  const name = env.WHATSAPP_PROVIDER?.trim();
  if (!name || name === "none") return null;
  if (name === "meta") {
    const token = env.WHATSAPP_ACCESS_TOKEN?.trim();
    const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
    if (!token || !phoneNumberId) throw new ConfigurationError("WHATSAPP_PROVIDER=meta needs WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID.");
    return metaCloudProvider({ token, phoneNumberId, templateName: env.WHATSAPP_TEMPLATE_NAME?.trim() || undefined, templateLang: env.WHATSAPP_TEMPLATE_LANG?.trim() || undefined, apiVersion: env.WHATSAPP_API_VERSION?.trim() || undefined });
  }
  throw new ConfigurationError(`WHATSAPP_PROVIDER="${name}" is not supported. Use "meta", or leave it empty for manual sharing.`);
}

/** Checks Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body with the app secret). */
export function verifyWebhookSignature(rawBody: string, header: string | null, appSecret: string | undefined): boolean {
  if (!appSecret || !header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", appSecret).update(rawBody).digest("hex"));
  const given = Buffer.from(header.slice(7));
  return given.length === expected.length && timingSafeEqual(given, expected);
}
