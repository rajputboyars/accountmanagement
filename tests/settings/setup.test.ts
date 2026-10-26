import { count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog } from "@/modules/audit/schema";
import { rolePermissions, users } from "@/modules/identity/schema";
import { isSetupComplete, runFirstTimeSetup, type SetupInput } from "@/modules/settings";
import { numberSeries, shops } from "@/modules/settings/schema";
import { ConflictError, ForbiddenError, NotFoundError } from "@/server/errors";
import { PERMISSIONS, ROLE_NAMES } from "@/shared/permissions";
import { randomPhone } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();

const input = (overrides: Partial<SetupInput> = {}): SetupInput => ({
  setupToken: process.env.SETUP_TOKEN!,
  shopName: "Sharma Sanitary & Hardware",
  stateCode: "08",
  ownerName: "Rakesh Sharma",
  ownerPhone: randomPhone(),
  ...overrides,
});

const shopCount = async () => (await db.owner.select({ n: count() }).from(shops))[0]!.n;

describe("first-run setup", () => {
  it("is disabled when SETUP_TOKEN is not configured", async () => {
    const saved = process.env.SETUP_TOKEN;
    delete process.env.SETUP_TOKEN;
    try {
      await expect(runFirstTimeSetup(input({ setupToken: "anything-at-all-anything-at-all-1234" }))).rejects.toBeInstanceOf(NotFoundError);
    } finally {
      process.env.SETUP_TOKEN = saved;
    }
    expect(await shopCount()).toBe(0);
  });

  it("rejects a wrong setup token and creates nothing", async () => {
    await expect(runFirstTimeSetup(input({ setupToken: "wrong-token" }))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await shopCount()).toBe(0);
    expect(await isSetupComplete()).toBe(false);
  });

  it("creates exactly one shop when two setups run at the same time", async () => {
    const results = await Promise.allSettled([runFirstTimeSetup(input()), runFirstTimeSetup(input())]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ConflictError);
    expect(await shopCount()).toBe(1);
  });

  it("creates the owner, default permissions, number series and a redacted audit entry", async () => {
    const [shop] = await db.owner.select().from(shops);
    const owners = await db.owner.select().from(users).where(eq(users.shopId, shop!.id));
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ role: "owner", isActive: true, pinHash: null });

    const permissionRows = await db.owner.select({ n: count() }).from(rolePermissions).where(eq(rolePermissions.shopId, shop!.id));
    expect(permissionRows[0]!.n).toBe(PERMISSIONS.length * ROLE_NAMES.length);

    const series = await db.owner.select().from(numberSeries).where(eq(numberSeries.shopId, shop!.id));
    expect(series.map((s) => s.series).sort()).toEqual(["ADJ", "CN", "GRN", "INV", "PO", "RCPT"]);

    const [audit] = await db.owner.select().from(auditLog).where(eq(auditLog.action, "setup.completed"));
    expect(audit!.after).toMatchObject({ setupToken: "[redacted]" });
    expect(JSON.stringify(audit)).not.toContain(process.env.SETUP_TOKEN!);
  });

  it("can never run again once a shop exists", async () => {
    await expect(runFirstTimeSetup(input())).rejects.toBeInstanceOf(ConflictError);
    expect(await isSetupComplete()).toBe(true);
    expect(await shopCount()).toBe(1);
  });

  it("validates the form before touching the database", async () => {
    await expect(runFirstTimeSetup(input({ ownerPhone: "123" }))).rejects.toThrow(/10-digit/);
    await expect(runFirstTimeSetup(input({ gstin: "NOT-A-GSTIN" }))).rejects.toThrow(/GSTIN/);
  });
});
