import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog } from "@/modules/audit/schema";
import { createProduct } from "@/modules/catalog";
import { countUnreadNotifications, decideApproval, getNotificationPreferences, listNotifications, markNotificationsRead, raiseNotification, requestApproval, setNotificationPreference } from "@/modules/identity";
import { notifications } from "@/modules/identity/schema";
import { recordOpeningStock } from "@/modules/inventory";
import { createCustomer, updateCustomer } from "@/modules/parties";
import { applyWhatsAppStatuses, getDashboard, MAX_ATTEMPTS, metaCloudProvider, processWhatsAppOutbox, ProviderError, queueDuesReminder, queueOverdueReminders, raiseBusinessAlerts, refreshBusinessAlerts, retryDelayMinutes, verifyWebhookSignature, type ReminderProvider } from "@/modules/reporting";
import { whatsappMessages } from "@/modules/reporting/schema";
import { ForbiddenError } from "@/server/errors";
import { indiaDate } from "@/shared/financial-year";
import { createTestShop, signInAs } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
const today = indiaDate();
const daysAgo = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
let n = 0;

async function setup() {
  n += 1;
  const shop = await createTestShop(db, `Notify ${n}`);
  const sessions = Object.fromEntries(await Promise.all((["owner", "manager", "cashier", "inventory"] as const).map(async (role) => [role, (await signInAs(shop.users[role])).session]))) as Record<"owner" | "manager" | "cashier" | "inventory", Awaited<ReturnType<typeof signInAs>>["session"]>;
  return { shop, ...sessions };
}

/** A fake provider: records calls, never touches the network. */
function fakeProvider(behaviour: (call: number) => "ok" | "retry" | "fatal" = () => "ok") {
  const calls: { phone: string; text: string }[] = [];
  const provider: ReminderProvider = {
    name: "fake",
    async send(message) {
      calls.push(message);
      const outcome = behaviour(calls.length);
      if (outcome === "retry") throw new ProviderError("Rate limited.", true);
      if (outcome === "fatal") throw new ProviderError("Number is not on WhatsApp.", false);
      return { providerMessageId: `wamid.${n}.${calls.length}` };
    },
  };
  return { provider, calls };
}

const debtor = (owner: Awaited<ReturnType<typeof setup>>["owner"], extra: Record<string, unknown> = {}) =>
  createCustomer(owner, { name: `Debtor ${++n}`, phone: String(9500000000 + n), type: "retail", creditLimit: "100000", openingOwed: "5000", oldestBillDate: daysAgo(45), whatsappConsent: true, ...extra }).then((result) => result.id);

const rowsFor = (userId: string) => db.owner.select().from(notifications).where(eq(notifications.userId, userId));

describe("in-app notifications", () => {
  it("raises an alert once per recipient and key, only for people allowed to act, respecting mutes", async () => {
    const { shop, owner, manager, cashier, inventory } = await setup();
    await setNotificationPreference(manager, "low_stock", false);
    const alert = { shopId: shop.shopId, kind: "low_stock" as const, title: "Stock", body: "2 out", dedupeKey: "low_stock:test", to: { permission: "inventory.view" as const } };
    expect(await raiseNotification(alert)).toBe(2); // owner + inventory; manager muted; cashier lacks the permission
    expect(await raiseNotification(alert)).toBe(0); // duplicate
    expect(await rowsFor(owner.userId)).toHaveLength(1);
    expect(await rowsFor(inventory.userId)).toHaveLength(1);
    expect(await rowsFor(manager.userId)).toHaveLength(0);
    expect(await rowsFor(cashier.userId)).toHaveLength(0);
    expect((await getNotificationPreferences(manager)).find((row) => row.kind === "low_stock")?.inApp).toBe(false);
    const [audit] = await db.owner.select().from(auditLog).where(and(eq(auditLog.entityId, manager.userId), eq(auditLog.action, "identity.notification_preference_set")));
    expect(audit).toMatchObject({ after: { kind: "low_stock", inApp: false } });
  });

  it("each person reads and clears only their own notifications; shops never see each other's", async () => {
    const { shop, owner, inventory } = await setup();
    const other = await setup();
    await raiseNotification({ shopId: shop.shopId, kind: "low_stock", title: "Stock", body: "x", dedupeKey: "k1", to: { permission: "inventory.view" } });
    const [ownerRow] = await listNotifications(owner);
    expect(await countUnreadNotifications(inventory)).toBe(1);
    expect(await markNotificationsRead(inventory, ownerRow!.id)).toBe(0); // not theirs
    expect(await countUnreadNotifications(owner)).toBe(1);
    expect(await markNotificationsRead(other.owner, ownerRow!.id)).toBe(0); // other shop
    expect(await markNotificationsRead(owner)).toBe(1);
    expect(await countUnreadNotifications(owner)).toBe(0);
    expect(await listNotifications(other.owner)).toEqual([]);
    // A user id from another shop is never a recipient.
    expect(await raiseNotification({ shopId: shop.shopId, kind: "import_finished", title: "x", body: "y", dedupeKey: "k2", to: { userIds: [other.owner.userId] } })).toBe(0);
  });

  it("tells the owner about approval requests and the requester about the decision, once each", async () => {
    const { owner, inventory } = await setup();
    const { id: productId } = await createProduct(owner, { name: `Pipe ${n}`, sku: `NP-${n}`, baseUnit: "pc", hsn: "3917", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "50" });
    const request = await requestApproval(inventory, { action: "stock_adjustment", targetRef: productId, targetLabel: "Pipe", reason: "Broken", amountPaise: 300000 });
    await requestApproval(inventory, { action: "stock_adjustment", targetRef: productId, targetLabel: "Pipe", reason: "Broken", amountPaise: 300000 }); // duplicate request
    expect((await listNotifications(owner)).filter((row) => row.kind === "approval_requested")).toHaveLength(1);
    await decideApproval(owner, { approvalId: request.id, decision: "approve" });
    const [decided] = await listNotifications(inventory);
    expect(decided).toMatchObject({ kind: "approval_decided", href: "/approvals" });
  });

  it("raises low-stock and overdue-dues summaries from real records, deduplicated across page loads", async () => {
    const { owner, manager, cashier } = await setup();
    const { id: productId } = await createProduct(owner, { name: `Tap ${n}`, sku: `NT-${n}`, baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "50" });
    await db.owner.execute(`update products set reorder_level = 100 where id = '${productId}'`);
    await recordOpeningStock(owner, { idempotencyKey: `k_${productId.replace(/-/g, "")}`, movementDate: today, lines: [{ productId, unit: "pc", quantity: "10" }] });
    await debtor(owner);
    expect(await refreshBusinessAlerts(owner)).toBeGreaterThan(0);
    expect(await refreshBusinessAlerts(manager)).toBe(0); // same day/week: nothing new
    const kinds = (await listNotifications(owner)).map((row) => row.kind).sort();
    expect(kinds).toEqual(["dues_overdue", "low_stock"]);
    expect((await listNotifications(manager)).map((row) => row.kind).sort()).toEqual(["dues_overdue", "low_stock"]);
    expect(await listNotifications(cashier)).toEqual([]); // cashier can't edit customers or see stock levels
  });
});

describe("business alerts from the dashboard", () => {
  it("raises the same alerts from the figures the dashboard loaded, once, without loading them again", async () => {
    const { owner, manager, cashier } = await setup();
    const { id: productId } = await createProduct(owner, { name: `Tap ${n}`, sku: `DT-${n}`, baseUnit: "pc", hsn: "8481", gstRateBp: "0", retailPaise: "100", wholesalePaise: "90", costPaise: "50" });
    await db.owner.execute(`update products set reorder_level = 100 where id = '${productId}'`);
    await recordOpeningStock(owner, { idempotencyKey: `k_${productId.replace(/-/g, "")}`, movementDate: today, lines: [{ productId, unit: "pc", quantity: "10" }] });
    await debtor(owner);
    const { alerts } = await getDashboard(owner);
    expect(alerts.stockCounts).toMatchObject({ reorder: 1 });
    expect(alerts.receivables?.rows.some((row) => row.overduePaise > 0)).toBe(true);
    expect(await raiseBusinessAlerts(owner, alerts)).toBeGreaterThan(0);
    expect(await raiseBusinessAlerts(owner, alerts)).toBe(0); // dashboard reloaded: deduplicated
    expect(await refreshBusinessAlerts(manager)).toBe(0); // the notifications page agrees it is already raised
    expect((await listNotifications(owner)).map((row) => row.kind).sort()).toEqual(["dues_overdue", "low_stock"]);
    expect(await listNotifications(cashier)).toEqual([]);
    // Nothing the viewer may not see → nothing raised.
    expect(await raiseBusinessAlerts(owner, { stockCounts: null, receivables: null })).toBe(0);
  });
});

describe("WhatsApp reminders", () => {
  it("needs a provider, consent, a phone and a balance; queues once per customer per day; audits", async () => {
    const { owner, inventory } = await setup();
    const { provider } = fakeProvider();
    const id = await debtor(owner);
    await expect(queueDuesReminder(owner, id, { provider: null })).rejects.toMatchObject({ code: "NO_PROVIDER" });
    await expect(queueDuesReminder(owner, await debtor(owner, { whatsappConsent: false }), { provider })).rejects.toMatchObject({ code: "NO_CONSENT" });
    await expect(queueDuesReminder(inventory, id, { provider })).rejects.toBeInstanceOf(ForbiddenError);
    const first = await queueDuesReminder(owner, id, { provider });
    const again = await queueDuesReminder(owner, id, { provider });
    expect(first).toMatchObject({ status: "queued", duplicate: false });
    expect(again).toMatchObject({ id: first.id, duplicate: true });
    const [audit] = await db.owner.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "reporting.whatsapp_queued")));
    expect(audit).toBeDefined();
  });

  it("sends with the provider, retries temporary failures with backoff, then fails and alerts", async () => {
    const { shop, owner } = await setup();
    const ok = fakeProvider();
    const sentId = await debtor(owner);
    await queueDuesReminder(owner, sentId, { provider: ok.provider });
    expect(await processWhatsAppOutbox({ shopId: shop.shopId, provider: ok.provider })).toMatchObject({ sent: 1 });
    const [sent] = await db.owner.select().from(whatsappMessages).where(eq(whatsappMessages.customerId, sentId));
    expect(sent).toMatchObject({ status: "sent", attempts: 1, providerMessageId: expect.stringMatching(/^wamid\./) });
    expect(ok.calls[0]!.text).toContain("Your balance with");

    const flaky = fakeProvider(() => "retry");
    const retryId = await debtor(owner);
    await queueDuesReminder(owner, retryId, { provider: flaky.provider });
    expect(await processWhatsAppOutbox({ shopId: shop.shopId, provider: flaky.provider })).toMatchObject({ retrying: 1 });
    const [waiting] = await db.owner.select().from(whatsappMessages).where(eq(whatsappMessages.customerId, retryId));
    expect(waiting).toMatchObject({ status: "queued", attempts: 1, lastError: "Rate limited." });
    expect(waiting!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
    expect(retryDelayMinutes(1)).toBe(1);
    expect(retryDelayMinutes(3)).toBe(16);
    // Not due yet: nothing is sent again.
    expect(await processWhatsAppOutbox({ shopId: shop.shopId, provider: flaky.provider })).toMatchObject({ sent: 0, retrying: 0 });
    await db.owner.update(whatsappMessages).set({ attempts: MAX_ATTEMPTS - 1, nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(whatsappMessages.id, waiting!.id));
    expect(await processWhatsAppOutbox({ shopId: shop.shopId, provider: flaky.provider })).toMatchObject({ failed: 1 });
    const [gaveUp] = await db.owner.select().from(whatsappMessages).where(eq(whatsappMessages.id, waiting!.id));
    expect(gaveUp).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
    expect((await listNotifications(owner)).find((row) => row.kind === "whatsapp_failed")?.href).toBe(`/customers/${retryId}`);

    const fatal = fakeProvider(() => "fatal");
    const fatalId = await debtor(owner);
    await queueDuesReminder(owner, fatalId, { provider: fatal.provider });
    expect(await processWhatsAppOutbox({ shopId: shop.shopId, provider: fatal.provider })).toMatchObject({ failed: 1 });
  });

  it("re-checks consent before sending and never sends a message twice", async () => {
    const { shop, owner } = await setup();
    const { provider, calls } = fakeProvider();
    const id = await debtor(owner);
    await queueDuesReminder(owner, id, { provider });
    await updateCustomer(owner, id, { name: `Debtor ${n}`, phone: String(9500000000 + n), type: "retail", creditLimit: "100000", whatsappConsent: "" });
    expect(await processWhatsAppOutbox({ shopId: shop.shopId, provider })).toMatchObject({ failed: 1 });
    expect(calls).toHaveLength(0);

    const second = await debtor(owner);
    await queueDuesReminder(owner, second, { provider });
    const results = await Promise.all([processWhatsAppOutbox({ shopId: shop.shopId, provider }), processWhatsAppOutbox({ shopId: shop.shopId, provider })]);
    expect(results.reduce((sum, result) => sum + result.sent, 0)).toBe(1);
    expect(calls).toHaveLength(1);

    // A send interrupted mid-way is failed as "outcome unknown", not repeated.
    const third = await debtor(owner);
    const queued = await queueDuesReminder(owner, third, { provider });
    await db.owner.update(whatsappMessages).set({ status: "sending", updatedAt: new Date(Date.now() - 11 * 60_000) }).where(eq(whatsappMessages.id, queued.id));
    await processWhatsAppOutbox({ shopId: shop.shopId, provider });
    const [stuck] = await db.owner.select().from(whatsappMessages).where(eq(whatsappMessages.id, queued.id));
    expect(stuck!.status).toBe("failed");
    expect(calls).toHaveLength(1);
  });

  it("only processes the given shop and applies webhook statuses forward-only", async () => {
    const a = await setup();
    const b = await setup();
    const { provider } = fakeProvider();
    const idA = await debtor(a.owner);
    await queueDuesReminder(a.owner, idA, { provider });
    expect(await processWhatsAppOutbox({ shopId: b.shop.shopId, provider })).toMatchObject({ sent: 0 });
    await processWhatsAppOutbox({ shopId: a.shop.shopId, provider });
    const [row] = await db.owner.select().from(whatsappMessages).where(eq(whatsappMessages.customerId, idA));
    expect(await applyWhatsAppStatuses([{ providerMessageId: row!.providerMessageId!, status: "read" }])).toBe(1);
    expect(await applyWhatsAppStatuses([{ providerMessageId: row!.providerMessageId!, status: "delivered" }])).toBe(0);
    expect(await applyWhatsAppStatuses([{ providerMessageId: "wamid.unknown", status: "failed" }])).toBe(0);
    const [read] = await db.owner.select().from(whatsappMessages).where(eq(whatsappMessages.id, row!.id));
    expect(read!.status).toBe("read");
  });

  it("queues overdue reminders in bulk only for consenting customers", async () => {
    const { owner, cashier } = await setup();
    const { provider } = fakeProvider();
    await debtor(owner);
    await debtor(owner, { whatsappConsent: false });
    await expect(queueOverdueReminders(cashier, { provider })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await queueOverdueReminders(owner, { provider })).toMatchObject({ queued: 1, noConsent: 1, overdueCustomers: 2 });
    expect(await queueOverdueReminders(owner, { provider })).toMatchObject({ queued: 0, alreadyToday: 1 });
  });
});

describe("Meta Cloud API provider and webhook security", () => {
  it("posts a template message and classifies failures, without the network", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const reply = (status: number, json: unknown) => async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(json), { status });
    };
    const ok = metaCloudProvider({ token: "t", phoneNumberId: "123", templateName: "dues" }, reply(200, { messages: [{ id: "wamid.1" }] }) as typeof fetch);
    expect(await ok.send({ phone: "9876543210", text: "Hello\nworld" })).toEqual({ providerMessageId: "wamid.1" });
    expect(requests[0]).toMatchObject({ url: "https://graph.facebook.com/v21.0/123/messages", body: { to: "919876543210", type: "template", template: { name: "dues", components: [{ parameters: [{ text: "Hello · world" }] }] } } });
    await expect(metaCloudProvider({ token: "t", phoneNumberId: "1" }, reply(429, { error: { message: "slow down" } }) as typeof fetch).send({ phone: "9876543210", text: "x" })).rejects.toMatchObject({ retryable: true });
    await expect(metaCloudProvider({ token: "t", phoneNumberId: "1" }, reply(400, { error: { message: "bad number" } }) as typeof fetch).send({ phone: "9876543210", text: "x" })).rejects.toMatchObject({ retryable: false });
  });

  it("accepts only correctly signed webhook bodies", () => {
    const body = JSON.stringify({ entry: [] });
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    expect(verifyWebhookSignature(body, signature, "secret")).toBe(true);
    expect(verifyWebhookSignature(`${body} `, signature, "secret")).toBe(false);
    expect(verifyWebhookSignature(body, signature, undefined)).toBe(false);
    expect(verifyWebhookSignature(body, null, "secret")).toBe(false);
  });
});
