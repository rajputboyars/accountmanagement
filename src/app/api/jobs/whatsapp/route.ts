import { timingSafeEqual } from "node:crypto";
import { processWhatsAppOutbox } from "@/modules/reporting";

/**
 * Sends queued WhatsApp messages and retries due ones, for every shop. Call it every minute from a
 * scheduler with `Authorization: Bearer $CRON_SECRET` (at least 32 characters). Without the secret
 * configured the route is disabled.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET ?? "";
  const given = Buffer.from((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
  const expected = Buffer.from(secret);
  if (secret.length < 32 || given.length !== expected.length || !timingSafeEqual(given, expected)) return new Response("Forbidden", { status: 403 });
  const result = await processWhatsAppOutbox({ limit: 100 });
  return Response.json(result);
}

/** Vercel Cron calls GET with the same `Authorization: Bearer $CRON_SECRET` header. */
export const GET = POST;
