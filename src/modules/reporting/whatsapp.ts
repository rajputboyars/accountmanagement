import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import { hasPermission, raiseNotification, requirePermission, type SessionContext } from "@/modules/identity";
import { findCustomer } from "@/modules/parties";
import { getDb, withTransaction } from "@/server/db";
import { ConflictError, NotFoundError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { CUSTOMER_TERMS_DAYS, listReceivables, prepareReminder } from "./accounts";
import { getReminderProvider, ProviderError, type ReminderProvider } from "./reminder-provider";
import { whatsappMessages, type WhatsAppStatus } from "./schema";

/**
 * WhatsApp dues reminders through the outbox. Queuing checks consent, phone and balance (the same
 * rules as the manual reminder) and allows one reminder per customer per day (a unique key, so a
 * double click or a bulk run never queues twice). The outbox worker sends with the configured
 * provider, re-checking consent right before sending; temporary failures retry with backoff up to
 * MAX_ATTEMPTS, permanent ones fail and alert the people who manage customers. Delivered/read come
 * only from the provider's signed webhook; "sent" means the provider accepted it, nothing more.
 */

export const MAX_ATTEMPTS = 5;
const actorOf = (session: SessionContext) => ({ shopId: session.shopId, userId: session.userId, role: session.role });

type QueueResult = { id: string; status: WhatsAppStatus; duplicate: boolean };

async function enqueue(session: SessionContext, customerId: string, provider: ReminderProvider | null): Promise<QueueResult> {
  if (!provider) throw new ConflictError("NO_PROVIDER", "No WhatsApp service is set up. Use Copy or Open WhatsApp instead.");
  const reminder = await prepareReminder(session, customerId); // permission, consent, phone and balance checks
  const dedupeKey = `dues:${customerId}:${indiaDate()}`;
  return withTransaction(async (tx) => {
    const [created] = await tx
      .insert(whatsappMessages)
      .values({ shopId: session.shopId, customerId, phone: reminder.phone, purpose: "dues_reminder", body: reminder.text, dedupeKey, createdBy: session.userId })
      .onConflictDoNothing({ target: [whatsappMessages.shopId, whatsappMessages.dedupeKey] })
      .returning({ id: whatsappMessages.id, status: whatsappMessages.status });
    if (!created) {
      const [existing] = await tx.select({ id: whatsappMessages.id, status: whatsappMessages.status }).from(whatsappMessages).where(and(eq(whatsappMessages.shopId, session.shopId), eq(whatsappMessages.dedupeKey, dedupeKey)));
      return { ...existing!, duplicate: true };
    }
    await recordAudit(tx, actorOf(session), { action: "reporting.whatsapp_queued", entityType: "customer", entityId: customerId, after: { messageId: created.id, purpose: "dues_reminder", provider: provider.name } });
    return { ...created, duplicate: false };
  });
}

/** Queue today's dues reminder for one customer (same permission as the manual reminder). */
export async function queueDuesReminder(session: SessionContext, customerId: string, options: { provider?: ReminderProvider | null } = {}) {
  return enqueue(session, customerId, options.provider === undefined ? getReminderProvider() : options.provider);
}

/** Queue reminders for every consenting customer with overdue bills (`customers.edit`). Others are counted, not messaged. */
export async function queueOverdueReminders(session: SessionContext, options: { provider?: ReminderProvider | null } = {}) {
  await requirePermission(session, "customers.edit");
  const provider = options.provider === undefined ? getReminderProvider() : options.provider;
  if (!provider) throw new ConflictError("NO_PROVIDER", "No WhatsApp service is set up.");
  const { rows } = await listReceivables(session);
  const overdue = rows.filter((row) => row.overduePaise > 0);
  const result = { queued: 0, alreadyToday: 0, noConsent: 0, noPhone: 0 };
  for (const row of overdue) {
    if (!row.whatsappConsent) result.noConsent += 1;
    else if (!row.phone) result.noPhone += 1;
    else if ((await enqueue(session, row.id, provider)).duplicate) result.alreadyToday += 1;
    else result.queued += 1;
  }
  return { ...result, overdueCustomers: overdue.length, termsDays: CUSTOMER_TERMS_DAYS };
}

/** Minutes to wait after the n-th failed attempt: 1, 4, 16, 64… */
export const retryDelayMinutes = (attempts: number) => 4 ** Math.max(0, attempts - 1);

async function failAndAlert(message: { id: string; shopId: string; customerId: string }, error: string) {
  await getDb().update(whatsappMessages).set({ status: "failed", lastError: error.slice(0, 500), updatedAt: sql`now()` }).where(eq(whatsappMessages.id, message.id));
  await raiseNotification({ shopId: message.shopId, kind: "whatsapp_failed", title: "WhatsApp reminder not sent", body: error.slice(0, 300), href: `/customers/${message.customerId}`, dedupeKey: `whatsapp:${message.id}:failed`, to: { permission: "customers.edit" } });
}

/**
 * Sends due messages (all shops for the scheduled job, or one shop for "Send now"). Rows are claimed
 * with SKIP LOCKED, so two workers never send the same message. A row stuck in "sending" (worker
 * crashed mid-send) is failed as "outcome unknown" rather than sent again, to avoid double messages.
 */
export async function processWhatsAppOutbox(options: { shopId?: string; limit?: number; provider?: ReminderProvider | null } = {}) {
  const db = getDb();
  const shopFilter = options.shopId ? sql`and shop_id = ${options.shopId}` : sql``;
  const stuck = await db.execute<{ id: string; shop_id: string; customer_id: string }>(sql`
    update whatsapp_messages set status = 'failed', last_error = 'Sending was interrupted; the outcome is unknown, so it was not sent again.', updated_at = now()
    where status = 'sending' and updated_at < now() - interval '10 minutes' ${shopFilter}
    returning id, shop_id, customer_id`);
  for (const row of stuck.rows) await failAndAlert({ id: row.id, shopId: row.shop_id, customerId: row.customer_id }, "Sending was interrupted; the outcome is unknown, so it was not sent again.");

  const claimed = await db.execute<{ id: string; shop_id: string; customer_id: string; phone: string; body: string; attempts: number }>(sql`
    update whatsapp_messages set status = 'sending', attempts = attempts + 1, updated_at = now()
    where id in (
      select id from whatsapp_messages where status = 'queued' and next_attempt_at <= now() ${shopFilter}
      order by next_attempt_at limit ${Math.min(Math.max(options.limit ?? 20, 1), 100)} for update skip locked)
    returning id, shop_id, customer_id, phone, body, attempts`);
  if (claimed.rows.length === 0) return { sent: 0, retrying: 0, failed: stuck.rows.length };

  let provider: ReminderProvider | null = null;
  let configError: string | null = null;
  try {
    provider = options.provider === undefined ? getReminderProvider() : options.provider;
  } catch (error) {
    configError = error instanceof Error ? error.message : "WhatsApp is not configured correctly.";
  }
  const counts = { sent: 0, retrying: 0, failed: stuck.rows.length };
  for (const row of claimed.rows) {
    const message = { id: row.id, shopId: row.shop_id, customerId: row.customer_id };
    if (!provider) {
      await failAndAlert(message, configError ?? "No WhatsApp service is set up any more.");
      counts.failed += 1;
      continue;
    }
    const customer = await findCustomer(row.shop_id, row.customer_id).catch(() => null);
    if (!customer?.whatsappConsent || customer.phone !== row.phone) {
      await failAndAlert(message, `${customer?.name ?? "The customer"} no longer has WhatsApp consent or the phone changed, so the reminder was not sent.`);
      counts.failed += 1;
      continue;
    }
    try {
      const { providerMessageId } = await provider.send({ phone: row.phone, text: row.body });
      await db.update(whatsappMessages).set({ status: "sent", providerMessageId, lastError: null, updatedAt: sql`now()` }).where(eq(whatsappMessages.id, row.id));
      counts.sent += 1;
    } catch (error) {
      const retryable = error instanceof ProviderError ? error.retryable : true;
      const text = error instanceof Error ? error.message : "Unknown error.";
      if (retryable && row.attempts < MAX_ATTEMPTS) {
        await db
          .update(whatsappMessages)
          .set({ status: "queued", lastError: text.slice(0, 500), nextAttemptAt: sql`now() + make_interval(mins => ${retryDelayMinutes(row.attempts)})`, updatedAt: sql`now()` })
          .where(eq(whatsappMessages.id, row.id));
        counts.retrying += 1;
      } else {
        await failAndAlert(message, `${text}${retryable ? ` Gave up after ${row.attempts} attempts.` : ""}`);
        counts.failed += 1;
      }
    }
  }
  return counts;
}

/** "Send now" for the person's own shop (`payments.record`, like reminders). */
export async function sendQueuedWhatsApp(session: SessionContext, options: { provider?: ReminderProvider | null } = {}) {
  await requirePermission(session, "payments.record");
  return processWhatsAppOutbox({ shopId: session.shopId, provider: options.provider });
}

const RANK: Record<WhatsAppStatus, number> = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4, failed: 5 };

/**
 * Applies status updates from the provider's (signature-checked) webhook. Status only moves forward
 * (sent → delivered → read); a "failed" from the provider fails the message and raises an alert.
 * Unknown message ids are ignored. Returns how many rows changed.
 */
export async function applyWhatsAppStatuses(updates: { providerMessageId: string; status: string; error?: string | null }[]) {
  const wanted = updates.filter((update): update is { providerMessageId: string; status: "sent" | "delivered" | "read" | "failed"; error?: string | null } => ["sent", "delivered", "read", "failed"].includes(update.status) && update.providerMessageId.length > 0);
  if (wanted.length === 0) return 0;
  const db = getDb();
  const rows = await db.select().from(whatsappMessages).where(inArray(whatsappMessages.providerMessageId, wanted.map((update) => update.providerMessageId)));
  let changed = 0;
  for (const update of wanted) {
    const row = rows.find((candidate) => candidate.providerMessageId === update.providerMessageId);
    if (!row || row.status === "failed" || RANK[update.status] <= RANK[row.status]) continue;
    if (update.status === "failed") await failAndAlert(row, `WhatsApp could not deliver the reminder: ${update.error ?? "no reason given"}.`);
    else await db.update(whatsappMessages).set({ status: update.status, updatedAt: sql`now()` }).where(eq(whatsappMessages.id, row.id));
    changed += 1;
  }
  return changed;
}

/** A customer's WhatsApp messages, newest first (`customers.view`). */
export async function listWhatsAppMessages(session: SessionContext, customerId: string) {
  await requirePermission(session, "customers.view");
  if (!/^[0-9a-f-]{36}$/i.test(customerId)) throw new NotFoundError("Customer not found.");
  const [rows, canSend] = await Promise.all([
    getDb()
      .select({ id: whatsappMessages.id, status: whatsappMessages.status, attempts: whatsappMessages.attempts, lastError: whatsappMessages.lastError, createdAt: whatsappMessages.createdAt, updatedAt: whatsappMessages.updatedAt })
      .from(whatsappMessages)
      .where(and(eq(whatsappMessages.shopId, session.shopId), eq(whatsappMessages.customerId, customerId)))
      .orderBy(desc(whatsappMessages.createdAt))
      .limit(20),
    hasPermission(session, "payments.record"),
  ]);
  return { rows, canSend };
}
