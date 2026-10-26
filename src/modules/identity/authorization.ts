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
