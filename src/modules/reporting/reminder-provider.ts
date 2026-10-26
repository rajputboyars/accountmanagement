import { ConfigurationError } from "@/server/errors";

/**
 * WhatsApp reminder integration boundary. No provider is built yet: a real one (WhatsApp Business
 * API through an approved BSP, with template approval and its own credentials) must implement this
 * interface and be selected with WHATSAPP_PROVIDER. Until then getReminderProvider() returns null and
 * the app offers copy / "Open WhatsApp" sharing only, never a fake "sent".
 */
export interface ReminderProvider {
  send(message: { phone: string; text: string }): Promise<void>;
}

export function getReminderProvider(env: NodeJS.ProcessEnv = process.env): ReminderProvider | null {
  const name = env.WHATSAPP_PROVIDER?.trim();
  if (!name || name === "none") return null;
  throw new ConfigurationError(`WHATSAPP_PROVIDER="${name}" is not supported yet. Leave it empty to use manual sharing.`);
}
