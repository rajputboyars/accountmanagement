import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auditLog } from "@/modules/audit/schema";
import { setUserLanguage } from "@/modules/identity";
import { partyBalance } from "@/modules/ledger";
import { createCustomer, findCustomer, setCustomerCommunicationLanguage, updateCustomer } from "@/modules/parties";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";
import { randomUUID } from "node:crypto";
import { customers } from "@/modules/parties/schema";

const db = setupTestDatabase();
let shop: TestShop;
let other: TestShop;
const owner = async (target = shop) => (await signInAs(target.users.owner)).session;
const input = { name: "Gupta Builders", phone: "", type: "wholesale", creditLimit: "1000" };

beforeAll(async () => {
  shop = await createTestShop(db);
  other = await createTestShop(db, "Other Shop");
});

describe("customer message language", () => {
  it("existing customers with no preference stay valid, and reading them works", async () => {
    const id = randomUUID();
    // Inserted the way a row from before this column existed looks: nothing set.
    await db.owner.insert(customers).values({ id, shopId: shop.shopId, name: "Old Customer", type: "retail" });
    const session = await owner();
    expect((await findCustomer(session.shopId, id)).communicationLanguage).toBeNull();
    await updateCustomer(session, id, { name: "Old Customer", type: "retail", creditLimit: "0" });
    expect((await findCustomer(session.shopId, id)).communicationLanguage).toBeNull();
  });

  it("is optional when adding a customer and saved when chosen", async () => {
    const session = await owner();
    const none = await createCustomer(session, input);
    expect((await findCustomer(session.shopId, none.id)).communicationLanguage).toBeNull();
    const chosen = await createCustomer(session, { ...input, name: "Verma Interiors", communicationLanguage: "hi" });
    expect((await findCustomer(session.shopId, chosen.id)).communicationLanguage).toBe("hi");
  });

  it("an edit that doesn't mention it keeps it; an empty choice clears it; an unknown one is refused", async () => {
    const session = await owner();
    const { id } = await createCustomer(session, { ...input, name: "Shree Ram", communicationLanguage: "hinglish" });
    await updateCustomer(session, id, { name: "Shree Ram Works", type: "retail", creditLimit: "0" });
    expect((await findCustomer(session.shopId, id)).communicationLanguage).toBe("hinglish");
    await expect(updateCustomer(session, id, { name: "Shree Ram Works", type: "retail", creditLimit: "0", communicationLanguage: "fr" })).rejects.toThrow();
    expect((await findCustomer(session.shopId, id)).communicationLanguage).toBe("hinglish");
    await updateCustomer(session, id, { name: "Shree Ram Works", type: "retail", creditLimit: "0", communicationLanguage: "" });
    expect((await findCustomer(session.shopId, id)).communicationLanguage).toBeNull();
  });

  it("is independent of the staff member's own screen language, in both directions", async () => {
    const session = await owner();
    await setUserLanguage(session, "hi");
    const { id } = await createCustomer(session, { ...input, name: "Mehta" });
    expect((await findCustomer(session.shopId, id)).communicationLanguage).toBeNull();
    await setCustomerCommunicationLanguage(session, id, "en");
    await setUserLanguage(session, "hinglish");
    expect((await findCustomer(session.shopId, id)).communicationLanguage).toBe("en");
    await setUserLanguage(session, "en");
  });

  it("saving it is audited, needs customer-edit permission and stays inside the shop", async () => {
    const session = await owner();
    const { id } = await createCustomer(session, { ...input, name: "Anil" });
    await setCustomerCommunicationLanguage(session, id, "hi");
    const rows = await db.owner.select().from(auditLog).where(and(eq(auditLog.shopId, shop.shopId), eq(auditLog.entityId, id), eq(auditLog.action, "parties.customer_language_set")));
    expect(rows).toHaveLength(1);
    await expect(setCustomerCommunicationLanguage((await signInAs(shop.users.inventory)).session, id, "en")).rejects.toThrow(ForbiddenError);
    await expect(setCustomerCommunicationLanguage(await owner(other), id, "en")).rejects.toThrow(NotFoundError);
    await expect(setCustomerCommunicationLanguage(session, id, "fr")).rejects.toThrow();
    expect((await findCustomer(session.shopId, id)).communicationLanguage).toBe("hi");
  });

  it("never touches the customer's balance", async () => {
    const session = await owner();
    const { id } = await createCustomer(session, { ...input, name: "Balance Check", openingOwed: "500" });
    const before = await partyBalance(session.shopId, "customer", id);
    await setCustomerCommunicationLanguage(session, id, "hi");
    await updateCustomer(session, id, { name: "Balance Check", type: "retail", creditLimit: "0", communicationLanguage: "en" });
    expect(await partyBalance(session.shopId, "customer", id)).toBe(before);
    expect(before).toBe(50000);
  });
});
