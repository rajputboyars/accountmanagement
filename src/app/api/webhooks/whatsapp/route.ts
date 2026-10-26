import { applyWhatsAppStatuses, verifyWebhookSignature } from "@/modules/reporting";

/**
 * WhatsApp Cloud API webhook. GET answers Meta's subscription check (WHATSAPP_VERIFY_TOKEN); POST
 * accepts message status updates only with a valid X-Hub-Signature-256 (WHATSAPP_APP_SECRET). No
 * session: the signature is the authentication, and only messages already in the outbox are updated.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = process.env.WHATSAPP_VERIFY_TOKEN;
  if (token && url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === token) {
    return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

type StatusPayload = { entry?: { changes?: { value?: { statuses?: { id?: string; status?: string; errors?: { title?: string; message?: string }[] }[] } }[] }[] };

export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > 1_000_000 || !verifyWebhookSignature(raw, request.headers.get("x-hub-signature-256"), process.env.WHATSAPP_APP_SECRET)) {
    return new Response("Forbidden", { status: 403 });
  }
  let payload: StatusPayload;
  try {
    payload = JSON.parse(raw) as StatusPayload;
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const updates = (payload.entry ?? []).flatMap((entry) =>
    (entry.changes ?? []).flatMap((change) => (change.value?.statuses ?? []).map((status) => ({ providerMessageId: String(status.id ?? ""), status: String(status.status ?? ""), error: status.errors?.[0]?.message ?? status.errors?.[0]?.title ?? null }))),
  );
  await applyWhatsAppStatuses(updates);
  return new Response("OK", { status: 200 });
}
