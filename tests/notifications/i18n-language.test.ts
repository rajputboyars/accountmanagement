import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auditLog } from "@/modules/audit/schema";
import { getUserLanguage, listNotifications, raiseNotification, setUserLanguage, type SessionContext } from "@/modules/identity";
import { notifications } from "@/modules/identity/schema";
import { createCustomer, setCustomerCommunicationLanguage } from "@/modules/parties";
import { processWhatsAppOutbox, queueDuesReminder, type ReminderProvider } from "@/modules/reporting";
import { whatsappMessages } from "@/modules/reporting/schema";
import { getBusinessSettings, updateBusinessProfile } from "@/modules/settings";
import { toActionError } from "@/server/action-result";
import { indiaDate } from "@/shared/financial-year";
import { translateServerMessage, translatorFor, type Language } from "@/shared/i18n";
import { notificationText } from "@/shared/i18n/labels";
import { addDays } from "@/shared/report-range";
import { duesReminderText } from "@/shared/reminder";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
let shop: TestShop;
let owner: SessionContext;
let n = 0;

/** A fake provider: records what would have been sent, and never touches the network. */
function fakeProvider() {
  const calls: { phone: string; text: string; language?: Language }[] = [];
  const provider: ReminderProvider = {
    name: "fake",
    async send(message) {
      calls.push(message);
      return { providerMessageId: `wamid.lang.${crypto.randomUUID()}` };
    },
  } as ReminderProvider;
  return { provider, calls };
}

const debtor = (language?: Language) => {
  n += 1;
  return createCustomer(owner, { name: `Debtor ${n}`, phone: String(9600000000 + n), type: "retail", creditLimit: "100000", openingOwed: "5000", oldestBillDate: addDays(indiaDate(), -45), whatsappConsent: true, communicationLanguage: language ?? "" }).then((row) => row.id);
};
const saved = async (customerId: string) => (await db.owner.select().from(whatsappMessages).where(eq(whatsappMessages.customerId, customerId)))[0]!;

beforeAll(async () => {
  shop = await createTestShop(db);
  owner = (await signInAs(shop.users.owner)).session as SessionContext;
});

describe("queued reminders and the customer's language", () => {
  it("a language change while queued is what goes out, with the queued figures; the screen language plays no part", async () => {
    await setUserLanguage(owner, "en");
    const id = await debtor("en");
    const { provider, calls } = fakeProvider();
    await queueDuesReminder(owner, id, { provider });
    const queued = await saved(id);
    expect(queued.body).toContain("Your outstanding");

    await setCustomerCommunicationLanguage(owner, id, "hi");
    expect((await saved(id)).body).toBe(queued.body); // nothing is rewritten until it is sent
    await processWhatsAppOutbox({ shopId: shop.shopId, provider });

    const facts = queued.template!.facts;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ language: "hi", text: duesReminderText(facts, "hi") });
    expect(calls[0]!.text).toContain("₹5,000.00");
    expect(calls[0]!.text).not.toContain("Your outstanding");
    const sent = await saved(id);
    expect(sent).toMatchObject({ status: "sent", attempts: 1, body: calls[0]!.text, dedupeKey: queued.dedupeKey });
  });

  it("no chosen language still means Hinglish, even with a Hindi screen", async () => {
    await setUserLanguage(owner, "hi");
    const id = await debtor();
    const { provider, calls } = fakeProvider();
    await queueDuesReminder(owner, id, { provider });
    await processWhatsAppOutbox({ shopId: shop.shopId, provider });
    expect(calls[0]).toMatchObject({ language: "hinglish" });
    expect(calls[0]!.text).toContain("Namaste");
    expect(calls[0]!.text).not.toMatch(/[ऀ-ॿ]/);
    await setUserLanguage(owner, "en");
  });

  it("a sent message never changes when the customer's language changes later, and it is not sent again", async () => {
    const id = await debtor("hinglish");
    const { provider, calls } = fakeProvider();
    await queueDuesReminder(owner, id, { provider });
    await processWhatsAppOutbox({ shopId: shop.shopId, provider });
    const sent = await saved(id);

    await setCustomerCommunicationLanguage(owner, id, "hi");
    await processWhatsAppOutbox({ shopId: shop.shopId, provider });
    expect(calls).toHaveLength(1);
    expect(await saved(id)).toEqual(sent);
  });

  it("queuing twice in a day stays one message, and one send, whatever the language", async () => {
    const id = await debtor("en");
    const { provider, calls } = fakeProvider();
    const first = await queueDuesReminder(owner, id, { provider });
    await setCustomerCommunicationLanguage(owner, id, "hi");
    const again = await queueDuesReminder(owner, id, { provider });
    expect(again).toMatchObject({ id: first.id, duplicate: true });
    expect(await db.owner.select().from(whatsappMessages).where(eq(whatsappMessages.customerId, id))).toHaveLength(1);
    await processWhatsAppOutbox({ shopId: shop.shopId, provider });
    await processWhatsAppOutbox({ shopId: shop.shopId, provider });
    expect(calls).toHaveLength(1);
  });

  it("a custom message, or one queued before templates, goes as saved", async () => {
    const id = await debtor("en");
    const { provider, calls } = fakeProvider();
    const { id: messageId } = await queueDuesReminder(owner, id, { provider });
    await db.owner.update(whatsappMessages).set({ body: "Bhai paisa bhej do", template: null }).where(eq(whatsappMessages.id, messageId));
    await setCustomerCommunicationLanguage(owner, id, "hi");
    await processWhatsAppOutbox({ shopId: shop.shopId, provider });
    expect(calls[0]).toMatchObject({ text: "Bhai paisa bhej do", language: "hi" });
    expect((await saved(id)).body).toBe("Bhai paisa bhej do");
  });
});

describe("staff notifications and saved language", () => {
  it("each reader sees the same saved row in their own saved language; the row and audit history do not change", async () => {
    const cashier = (await signInAs(shop.users.cashier)).session as SessionContext;
    await setUserLanguage(owner, "hi");
    await setUserLanguage(cashier, "hinglish");
    expect(await getUserLanguage(owner)).toBe("hi");
    expect(await getUserLanguage(cashier)).toBe("hinglish");

    const title = "1 customer has overdue bills";
    const body = "₹500 overdue (bills older than 30 days). Highest: Gupta Traders.";
    await raiseNotification({ shopId: shop.shopId, kind: "dues_overdue", title, body, dedupeKey: `lang:${crypto.randomUUID()}`, to: { userIds: [owner.userId, cashier.userId] } });

    const read = async (session: SessionContext, language: Language) => {
      const [row] = (await listNotifications(session)).filter((item) => item.title === title);
      expect(row).toMatchObject({ title, body }); // stored as written
      return notificationText(row!, translatorFor(language), language);
    };
    const inHindi = await read(owner, "hi");
    const inHinglish = await read(cashier, "hinglish");
    expect(inHindi.body).toBe(translatorFor("hi")("server.alertDuesBody", { amount: "₹500", name: "Gupta Traders" }));
    expect(inHinglish.body).toBe(translatorFor("hinglish")("server.alertDuesBody", { amount: "₹500", name: "Gupta Traders" }));

    const before = await db.owner.select().from(notifications).where(eq(notifications.title, title));
    const audit = await db.owner.select().from(auditLog).where(eq(auditLog.action, "identity.language_set"));
    await setUserLanguage(owner, "en");
    expect(await db.owner.select().from(notifications).where(eq(notifications.title, title))).toEqual(before);
    const after = await db.owner.select().from(auditLog).where(eq(auditLog.action, "identity.language_set"));
    expect(after.slice(0, audit.length).map((row) => row.after)).toEqual(audit.map((row) => row.after)); // only added to
    expect(after.length).toBe(audit.length + 1);
  });
});

describe("settings refusals and saved values", () => {
  it("validation reads in Hindi, and the state stays saved as its code", async () => {
    const message = async (work: Promise<unknown>) => translateServerMessage((await toActionError(await work.then(() => null, (error: unknown) => error))).error, "hi");
    const profile = { name: "Sharma Sanitary", legalName: "", address: "Jaipur", phone: "", stateCode: "27", email: "", pinCode: "" };
    expect(await message(updateBusinessProfile(owner, { ...profile, stateCode: "zz" }))).toBe("राज्य चुनें।");
    expect(await message(updateBusinessProfile(owner, { ...profile, email: "not-an-email" }))).toBe("यह ईमेल पता नहीं लगता।");
    expect(await message(updateBusinessProfile(owner, { ...profile, pinCode: "012345" }))).toBe("पिन कोड में 6 अंक होते हैं और 0 से शुरू नहीं होता।");
    await updateBusinessProfile(owner, profile);
    expect((await getBusinessSettings(owner)).profile).toMatchObject({ stateCode: "27", address: "Jaipur" });
  });
});
