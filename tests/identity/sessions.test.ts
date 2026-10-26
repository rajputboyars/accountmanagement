import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { SESSION_TTL_SECONDS, signOut, validateSessionToken } from "@/modules/identity";
import { sessions, users } from "@/modules/identity/schema";
import { sha256Hex } from "@/server/crypto";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
let shop: TestShop;

beforeAll(async () => {
  shop = await createTestShop(db);
});

describe("sessions", () => {
  it("stores only the SHA-256 hash of the token", async () => {
    const { token, session } = await signInAs(shop.users.cashier);
    const [row] = await db.owner.select().from(sessions).where(eq(sessions.id, session.sessionId));
    expect(row!.tokenHash).toBe(sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("derives shop and role from the database, not the caller", async () => {
    const { session } = await signInAs(shop.users.inventory);
    expect(session).toMatchObject({ shopId: shop.shopId, role: "inventory", userId: shop.users.inventory.id });
  });

  it("uses a 12-hour session for counter staff and 30 days for the owner", async () => {
    const cashier = await signInAs(shop.users.cashier);
    const owner = await signInAs(shop.users.owner);
    const hours = (date: Date) => (date.getTime() - Date.now()) / 3_600_000;
    expect(hours(cashier.session.expiresAt)).toBeCloseTo(SESSION_TTL_SECONDS.cashier / 3600, 0);
    expect(hours(owner.session.expiresAt)).toBeCloseTo(SESSION_TTL_SECONDS.owner / 3600, 0);
  });

  it("rejects an expired session", async () => {
    const { token, session } = await signInAs(shop.users.manager);
    await db.owner.update(sessions).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(sessions.id, session.sessionId));
    expect(await validateSessionToken(token)).toBeNull();
  });

  it("signs out (revokes) a session, and signing out twice is harmless", async () => {
    const { token } = await signInAs(shop.users.cashier);
    await signOut(token);
    expect(await validateSessionToken(token)).toBeNull();
    await expect(signOut(token)).resolves.toBeUndefined();
  });

  it("rejects missing, malformed and unknown tokens", async () => {
    expect(await validateSessionToken(undefined)).toBeNull();
    expect(await validateSessionToken("short")).toBeNull();
    expect(await validateSessionToken("x".repeat(43))).toBeNull();
  });

  it("rejects sessions of deactivated users", async () => {
    const { token } = await signInAs(shop.users.inventory);
    await db.owner.update(users).set({ isActive: false }).where(eq(users.id, shop.users.inventory.id));
    expect(await validateSessionToken(token)).toBeNull();
    await db.owner.update(users).set({ isActive: true }).where(eq(users.id, shop.users.inventory.id));
  });

  it("issues a new token on every sign-in (no session fixation)", async () => {
    const a = await signInAs(shop.users.owner);
    const b = await signInAs(shop.users.owner);
    expect(a.token).not.toBe(b.token);
    expect(a.session.sessionId).not.toBe(b.session.sessionId);
  });
});
