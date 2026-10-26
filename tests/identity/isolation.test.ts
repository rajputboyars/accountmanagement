import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { addStaffMember, getStaffMember, listStaff, setStaffActive, validateSessionToken } from "@/modules/identity";
import { users } from "@/modules/identity/schema";
import { getCurrentShop } from "@/modules/settings";
import { NotFoundError } from "@/server/errors";
import { createTestShop, randomPhone, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
let shopA: TestShop;
let shopB: TestShop;

beforeAll(async () => {
  shopA = await createTestShop(db, "Shop A");
  shopB = await createTestShop(db, "Shop B");
});

describe("shop isolation", () => {
  it("binds the session to its own shop", async () => {
    const { token } = await signInAs(shopA.users.owner);
    const session = await validateSessionToken(token);
    expect(session?.shopId).toBe(shopA.shopId);
    expect((await getCurrentShop(session!)).name).toBe("Shop A");
  });

  it("lists only the caller's own shop", async () => {
    const { session } = await signInAs(shopA.users.owner);
    const staff = await listStaff(session);
    const ids = staff.map((member) => member.id);
    expect(ids).toContain(shopA.users.cashier.id);
    expect(ids).not.toContain(shopB.users.cashier.id);
    expect(staff.every((member) => !("pinHash" in member))).toBe(true);
  });

  it("treats a guessed record ID from another shop as not found (read)", async () => {
    const { session } = await signInAs(shopA.users.owner);
    await expect(getStaffMember(session, shopB.users.cashier.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getStaffMember(session, shopA.users.cashier.id)).resolves.toMatchObject({ id: shopA.users.cashier.id });
  });

  it("cannot change a record in another shop (write)", async () => {
    const { session } = await signInAs(shopA.users.owner);
    await expect(setStaffActive(session, shopB.users.cashier.id, false)).rejects.toBeInstanceOf(NotFoundError);
    const [target] = await db.owner.select({ isActive: users.isActive }).from(users).where(eq(users.id, shopB.users.cashier.id));
    expect(target!.isActive).toBe(true);
  });

  it("ignores a shop ID smuggled into the request body", async () => {
    const { session } = await signInAs(shopA.users.owner);
    const created = await addStaffMember(session, { name: "Body Shop", phone: randomPhone(), role: "cashier", shopId: shopB.shopId });
    const [row] = await db.owner.select({ shopId: users.shopId }).from(users).where(eq(users.id, created.id));
    expect(row!.shopId).toBe(shopA.shopId);
  });

  it("signs a deactivated person out of every session in their own shop", async () => {
    const owner = await signInAs(shopA.users.owner);
    const cashier = await signInAs(shopA.users.cashier);
    await setStaffActive(owner.session, shopA.users.cashier.id, false);
    expect(await validateSessionToken(cashier.token)).toBeNull();
    await setStaffActive(owner.session, shopA.users.cashier.id, true);
  });
});
