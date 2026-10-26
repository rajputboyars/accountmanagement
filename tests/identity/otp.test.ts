import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { OTP_MAX_ATTEMPTS, requestSignInCode, SignInError, signInWithCode, validateSessionToken } from "@/modules/identity";
import { otpRequests } from "@/modules/identity/schema";
import { RateLimitedError } from "@/server/errors";
import { CapturingSender, createTestShop, randomPhone, type TestShop } from "../helpers/factories";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();
let shop: TestShop;

beforeAll(async () => {
  shop = await createTestShop(db);
});

/** Moves a phone's OTP history back in time so the 30-second resend cooldown doesn't apply. */
async function skipCooldown(phone: string, seconds = 40) {
  await db.owner
    .update(otpRequests)
    .set({ createdAt: sql`${otpRequests.createdAt} - make_interval(secs => ${seconds})` })
    .where(eq(otpRequests.phone, phone));
}

async function expectSignInFailure(promise: Promise<unknown>, reason: SignInError["reason"]) {
  await expect(promise).rejects.toBeInstanceOf(SignInError);
  await promise.catch((error: SignInError) => expect(error.reason).toBe(reason));
}

describe("OTP sign-in", () => {
  it("signs in with the right code and returns a valid session", async () => {
    const sender = new CapturingSender();
    const user = shop.users.cashier;
    await requestSignInCode({ phone: user.phone }, { sender });
    const result = await signInWithCode({ phone: user.phone, code: sender.lastCodeFor(user.phone) });

    expect(result.user).toMatchObject({ id: user.id, shopId: shop.shopId, role: "cashier" });
    const session = await validateSessionToken(result.token);
    expect(session?.userId).toBe(user.id);
  });

  it("stores only a keyed hash of the code", async () => {
    const sender = new CapturingSender();
    const phone = shop.users.manager.phone;
    await requestSignInCode({ phone }, { sender });
    const code = sender.lastCodeFor(phone);
    const [row] = await db.owner.select().from(otpRequests).where(eq(otpRequests.phone, phone));
    expect(row!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.codeHash).not.toContain(code);
  });

  it("rejects a wrong code and counts the attempt", async () => {
    const sender = new CapturingSender();
    const phone = shop.users.inventory.phone;
    await requestSignInCode({ phone }, { sender });
    const wrong = sender.lastCodeFor(phone) === "000000" ? "111111" : "000000";
    const attempt = signInWithCode({ phone, code: wrong });
    await expectSignInFailure(attempt, "invalid_code");
    await attempt.catch((error: SignInError) => expect(error.attemptsLeft).toBe(OTP_MAX_ATTEMPTS - 1));
  });

  it("rejects an expired code", async () => {
    const sender = new CapturingSender();
    const phone = shop.users.owner.phone;
    await requestSignInCode({ phone }, { sender });
    await db.owner.update(otpRequests).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(otpRequests.phone, phone));
    await expectSignInFailure(signInWithCode({ phone, code: sender.lastCodeFor(phone) }), "expired");
  });

  it("does not accept the same code twice", async () => {
    const sender = new CapturingSender();
    const phone = shop.users.cashier.phone;
    await skipCooldown(phone);
    await requestSignInCode({ phone }, { sender });
    const code = sender.lastCodeFor(phone);
    await signInWithCode({ phone, code });
    await expectSignInFailure(signInWithCode({ phone, code }), "no_active_code");
  });

  it("lets only one of two simultaneous sign-ins with the same code succeed", async () => {
    const sender = new CapturingSender();
    const phone = shop.users.cashier.phone;
    await skipCooldown(phone);
    await requestSignInCode({ phone }, { sender });
    const code = sender.lastCodeFor(phone);
    const results = await Promise.allSettled([signInWithCode({ phone, code }), signInWithCode({ phone, code })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("locks the code after too many wrong attempts, even for the right code", async () => {
    const sender = new CapturingSender();
    const phone = shop.users.manager.phone;
    await skipCooldown(phone);
    await requestSignInCode({ phone }, { sender });
    const code = sender.lastCodeFor(phone);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < OTP_MAX_ATTEMPTS - 1; i++) {
      await expectSignInFailure(signInWithCode({ phone, code: wrong }), "invalid_code");
    }
    await expectSignInFailure(signInWithCode({ phone, code: wrong }), "too_many_attempts");
    await expectSignInFailure(signInWithCode({ phone, code }), "too_many_attempts");
  });

  it("invalidates the previous code when a new one is requested", async () => {
    const sender = new CapturingSender();
    const phone = shop.users.inventory.phone;
    await skipCooldown(phone);
    await requestSignInCode({ phone }, { sender });
    const first = sender.lastCodeFor(phone);
    await skipCooldown(phone);
    await requestSignInCode({ phone }, { sender });
    const second = sender.lastCodeFor(phone);
    if (first !== second) await expect(signInWithCode({ phone, code: first })).rejects.toBeInstanceOf(SignInError);
    await expect(signInWithCode({ phone, code: second })).resolves.toMatchObject({ user: { role: "inventory" } });
  });

  it("enforces the resend cooldown and the hourly limit", async () => {
    const sender = new CapturingSender();
    const phone = shop.users.owner.phone;
    await skipCooldown(phone, 3700); // clear earlier requests out of the hour window
    await requestSignInCode({ phone }, { sender });
    await expect(requestSignInCode({ phone }, { sender })).rejects.toBeInstanceOf(RateLimitedError);

    for (let i = 1; i < 5; i++) {
      await skipCooldown(phone);
      await requestSignInCode({ phone }, { sender });
    }
    await skipCooldown(phone);
    await expect(requestSignInCode({ phone }, { sender })).rejects.toThrow(/Try again in an hour/);
  });

  it("answers the same way for unknown numbers and sends nothing", async () => {
    const sender = new CapturingSender();
    const phone = randomPhone();
    await expect(requestSignInCode({ phone }, { sender })).resolves.toEqual({ resendAfterSeconds: 30 });
    expect(sender.sent).toHaveLength(0);
    const rows = await db.owner.select().from(otpRequests).where(eq(otpRequests.phone, phone));
    expect(rows).toHaveLength(0);
  });

  it("rejects malformed phone numbers and codes", async () => {
    await expect(requestSignInCode({ phone: "12345" }, { sender: new CapturingSender() })).rejects.toThrow();
    await expect(signInWithCode({ phone: shop.users.owner.phone, code: "12ab56" })).rejects.toThrow();
  });
});
