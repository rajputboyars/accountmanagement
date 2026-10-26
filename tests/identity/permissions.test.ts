import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { addStaffMember, hasPermission, listStaff, requirePermission } from "@/modules/identity";
import { rolePermissions } from "@/modules/identity/schema";
import { ForbiddenError } from "@/server/errors";
import type { Permission } from "@/shared/permissions";
import { createTestShop, randomPhone, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
let shop: TestShop;

beforeAll(async () => {
  shop = await createTestShop(db);
});

const allowed = async (role: keyof TestShop["users"], permission: Permission) => {
  const { session } = await signInAs(shop.users[role]);
  return hasPermission(session, permission);
};

describe("role permissions", () => {
  it.each([
    ["owner", "staff.manage", true],
    ["owner", "profit.view", true],
    ["owner", "day.close", true],
    ["cashier", "billing.create", true],
    ["cashier", "payments.record", true],
    ["cashier", "staff.manage", false],
    ["cashier", "profit.view", false],
    ["cashier", "stock.adjust", false],
    ["inventory", "stock.adjust", true],
    ["inventory", "stock.receive", true],
    ["inventory", "billing.create", false],
    ["inventory", "customers.view", false],
    ["manager", "day.close", false],
    ["manager", "reports.view", true],
  ] as const)("%s → %s = %s", async (role, permission, expected) => {
    expect(await allowed(role, permission)).toBe(expected);
  });

  it("denies unknown permissions", async () => {
    const { session } = await signInAs(shop.users.owner);
    expect(await hasPermission(session, "everything.delete" as Permission)).toBe(false);
  });

  it("denies by default when the permission row is missing, and follows owner changes immediately", async () => {
    const { session } = await signInAs(shop.users.cashier);
    expect(await hasPermission(session, "billing.view")).toBe(true);
    await db.owner
      .delete(rolePermissions)
      .where(and(eq(rolePermissions.shopId, shop.shopId), eq(rolePermissions.role, "cashier"), eq(rolePermissions.permission, "billing.view")));
    expect(await hasPermission(session, "billing.view")).toBe(false);
    await expect(requirePermission(session, "billing.view")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("enforces permissions inside services, not just in the UI", async () => {
    const cashier = await signInAs(shop.users.cashier);
    const inventory = await signInAs(shop.users.inventory);
    await expect(listStaff(cashier.session)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addStaffMember(inventory.session, { name: "Sneaky", phone: randomPhone(), role: "manager" })).rejects.toBeInstanceOf(ForbiddenError);

    const owner = await signInAs(shop.users.owner);
    await expect(addStaffMember(owner.session, { name: "New Cashier", phone: randomPhone(), role: "cashier" })).resolves.toMatchObject({ role: "cashier" });
  });

  it("does not let staff be created as owner", async () => {
    const owner = await signInAs(shop.users.owner);
    await expect(addStaffMember(owner.session, { name: "Second Owner", phone: randomPhone(), role: "owner" })).rejects.toThrow();
  });
});
