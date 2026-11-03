import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auditLog } from "@/modules/audit/schema";
import { getUserLanguage, setUserLanguage } from "@/modules/identity";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
let shop: TestShop;

beforeAll(async () => {
  shop = await createTestShop(db);
});

describe("language preference", () => {
  it("defaults to English and is saved per person, not per shop", async () => {
    const { session: owner } = await signInAs(shop.users.owner);
    const { session: cashier } = await signInAs(shop.users.cashier);
    expect(await getUserLanguage(owner)).toBe("en");

    await setUserLanguage(owner, "hi");

    expect(await getUserLanguage(owner)).toBe("hi");
    expect(await getUserLanguage(cashier)).toBe("en");
  });

  it("is still there after signing in again, as on another device", async () => {
    const { session: first } = await signInAs(shop.users.manager);
    await setUserLanguage(first, "hinglish");
    const { session: second } = await signInAs(shop.users.manager);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(await getUserLanguage(second)).toBe("hinglish");
  });

  it("refuses an unknown language and writes an audit row for a real change", async () => {
    const { session: owner } = await signInAs(shop.users.owner);
    await expect(setUserLanguage(owner, "fr")).rejects.toThrow();
    expect(await getUserLanguage(owner)).toBe("hi");
    await setUserLanguage(owner, "en");
    const rows = await db.owner.select().from(auditLog).where(and(eq(auditLog.shopId, shop.shopId), eq(auditLog.action, "identity.language_set")));
    expect(rows.length).toBeGreaterThan(0);
  });
});
