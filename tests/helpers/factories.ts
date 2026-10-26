import { randomInt } from "node:crypto";
import { createSession, validateSessionToken, type OtpSender, type SessionContext } from "@/modules/identity";
import { DEFAULT_UNITS } from "@/modules/catalog/units";
import { units } from "@/modules/catalog/schema";
import { rolePermissions, users } from "@/modules/identity/schema";
import { shops } from "@/modules/settings/schema";
import { withTransaction } from "@/server/db";
import { defaultPermissionRows, type RoleName } from "@/shared/permissions";
import type { TestDatabase } from "./test-db";

export function randomPhone(): string {
  return `9${randomInt(100_000_000, 999_999_999)}`;
}

export type TestUser = { id: string; phone: string; role: RoleName; shopId: string; name: string };
export type TestShop = { shopId: string; users: Record<RoleName, TestUser> };

/** A shop with one user per role, the default permission table and default units, inserted as the schema owner. */
export async function createTestShop(db: TestDatabase, name = "Test Shop"): Promise<TestShop> {
  const [shop] = await db.owner.insert(shops).values({ name, stateCode: "08" }).returning({ id: shops.id });
  const shopId = shop!.id;
  await db.owner.insert(rolePermissions).values(defaultPermissionRows().map((row) => ({ shopId, ...row })));
  await db.owner.insert(units).values(DEFAULT_UNITS.map((unit) => ({ shopId, ...unit })));
  const roles: RoleName[] = ["owner", "manager", "cashier", "inventory"];
  const created = {} as Record<RoleName, TestUser>;
  for (const role of roles) {
    const phone = randomPhone();
    const [row] = await db.owner.insert(users).values({ shopId, name: `${role} of ${name}`, phone, role }).returning({ id: users.id });
    created[role] = { id: row!.id, phone, role, shopId, name: `${role} of ${name}` };
  }
  return { shopId, users: created };
}

/** A real session (via the app code path) and its validated context. */
export async function signInAs(user: TestUser): Promise<{ token: string; session: SessionContext }> {
  const { token } = await withTransaction((tx) => createSession(tx, { id: user.id, role: user.role }));
  const session = await validateSessionToken(token);
  if (!session) throw new Error("test session did not validate");
  return { token, session };
}

/** Captures codes instead of sending SMS. */
export class CapturingSender implements OtpSender {
  readonly name = "capture";
  readonly sent: { phone: string; code: string }[] = [];
  async send(message: { phone: string; code: string }) {
    this.sent.push(message);
  }
  lastCodeFor(phone: string): string {
    const match = [...this.sent].reverse().find((message) => message.phone === phone);
    if (!match) throw new Error(`no code sent to ${phone}`);
    return match.code;
  }
}
