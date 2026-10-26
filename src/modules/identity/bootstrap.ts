import { eq } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import { withTransaction, type Transaction } from "@/server/db";
import { defaultPermissionRows } from "@/shared/permissions";
import { revokeSessionByToken } from "./sessions";
import { rolePermissions, users } from "./schema";

/** Called by first-run setup inside its transaction: the owner account and default permissions. */
export async function bootstrapOwner(tx: Transaction, shopId: string, owner: { name: string; phone: string }): Promise<{ ownerId: string }> {
  const [row] = await tx.insert(users).values({ shopId, name: owner.name, phone: owner.phone, role: "owner" }).returning({ id: users.id });
  await tx.insert(rolePermissions).values(defaultPermissionRows().map((permission) => ({ shopId, ...permission })));
  return { ownerId: row!.id };
}

/** Revokes the session behind a token. Safe to call with an unknown or already-revoked token. */
export async function signOut(token: string | undefined | null): Promise<void> {
  if (!token) return;
  await withTransaction(async (tx) => {
    const revoked = await revokeSessionByToken(tx, token);
    if (!revoked) return;
    const [user] = await tx.select({ shopId: users.shopId, role: users.role }).from(users).where(eq(users.id, revoked.userId)).limit(1);
    if (user) {
      await recordAudit(tx, { shopId: user.shopId, userId: revoked.userId, role: user.role }, {
        action: "auth.sign_out",
        entityType: "session",
        entityId: revoked.sessionId,
      });
    }
  });
}
