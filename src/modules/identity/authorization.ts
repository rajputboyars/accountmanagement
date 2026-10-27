import { and, eq } from "drizzle-orm";
import { getDb, type Database, type Transaction } from "@/server/db";
import { ForbiddenError } from "@/server/errors";
import { isPermission, type Permission } from "@/shared/permissions";
import type { SessionContext } from "./sessions";
import { rolePermissions } from "./schema";

/**
 * Deny by default: a permission is granted only when role_permissions has an explicit
 * allowed = true row for the session's shop and role. Shop and role come from the validated
 * session, never from the request.
 */
export async function hasPermission(
  session: Pick<SessionContext, "shopId" | "role">,
  permission: Permission,
  db: Database | Transaction = getDb(),
): Promise<boolean> {
  if (!isPermission(permission)) return false;
  const [row] = await db
    .select({ allowed: rolePermissions.allowed })
    .from(rolePermissions)
    .where(
      and(
        eq(rolePermissions.shopId, session.shopId),
        eq(rolePermissions.role, session.role),
        eq(rolePermissions.permission, permission),
      ),
    )
    .limit(1);
  return row?.allowed === true;
}

/**
 * Every permission the session's role holds, in one query: for screens that check several at once
 * instead of one round trip each. Same deny-by-default rule as hasPermission.
 */
export async function loadPermissions(session: Pick<SessionContext, "shopId" | "role">, db: Database | Transaction = getDb()): Promise<ReadonlySet<Permission>> {
  const rows = await db
    .select({ permission: rolePermissions.permission })
    .from(rolePermissions)
    .where(and(eq(rolePermissions.shopId, session.shopId), eq(rolePermissions.role, session.role), eq(rolePermissions.allowed, true)));
  return new Set(rows.map((row) => row.permission).filter(isPermission));
}

/** Throws ForbiddenError unless the session's role holds the permission. */
export async function requirePermission(
  session: Pick<SessionContext, "shopId" | "role">,
  permission: Permission,
  db?: Database | Transaction,
): Promise<void> {
  if (!(await hasPermission(session, permission, db))) {
    throw new ForbiddenError();
  }
}
