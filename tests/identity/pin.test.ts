import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { PIN_MAX_FAILURES, setOwnerPin, verifyOwnerPin } from "@/modules/identity";
import { auditLog } from "@/modules/audit/schema";
import { users } from "@/modules/identity/schema";
import { ConflictError, ForbiddenError, RateLimitedError, ValidationError } from "@/server/errors";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
let shop: TestShop;
const PIN = "2580";

beforeAll(async () => {
  shop = await createTestShop(db);
});

describe("owner approval PIN", () => {
  it("cannot be verified before the owner sets it", async () => {
    const { session } = await signInAs(shop.users.cashier);
    await expect(verifyOwnerPin(session, PIN)).rejects.toBeInstanceOf(ConflictError);
  });

  it("can only be set by the owner", async () => {
    const { session } = await signInAs(shop.users.manager);
    await expect(setOwnerPin(session, PIN)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects weak or malformed PINs", async () => {
    const { session } = await signInAs(shop.users.owner);
    for (const weak of ["1234", "1111", "9876", "12", "abcd", "1234567"]) {
      await expect(setOwnerPin(session, weak)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("stores an Argon2id hash, never the PIN", async () => {
    const { session } = await signInAs(shop.users.owner);
    await setOwnerPin(session, PIN);
    const [owner] = await db.owner.select({ pinHash: users.pinHash }).from(users).where(eq(users.id, shop.users.owner.id));
    expect(owner!.pinHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(owner!.pinHash).not.toContain(PIN);
  });

  it("accepts the right PIN entered at a cashier's counter", async () => {
    const { session } = await signInAs(shop.users.cashier);
    await expect(verifyOwnerPin(session, PIN)).resolves.toBe(true);
  });

  it("counts wrong PINs and locks approvals after five, even for the right PIN", async () => {
    const { session } = await signInAs(shop.users.cashier);
    for (let i = 1; i < PIN_MAX_FAILURES; i++) {
      await expect(verifyOwnerPin(session, "0852")).rejects.toThrow(`${PIN_MAX_FAILURES - i} attempts left`);
    }
    await expect(verifyOwnerPin(session, "0852")).rejects.toBeInstanceOf(RateLimitedError);
    await expect(verifyOwnerPin(session, PIN)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("never writes the PIN or its hash into the audit log", async () => {
    const rows = await db.owner.select().from(auditLog).where(eq(auditLog.entityId, shop.users.owner.id));
    expect(rows.length).toBeGreaterThan(0);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(PIN);
    expect(text).not.toContain("$argon2id$");
  });
});
