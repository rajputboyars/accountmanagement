import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/modules/audit";
import { getDb, withTransaction, type Transaction } from "@/server/db";
import { ConflictError, ForbiddenError, NotFoundError } from "@/server/errors";
import type { RoleName } from "@/shared/permissions";
import { requirePermission } from "./authorization";
import { phoneSchema } from "./otp";
import { revokeAllSessionsForUser, type SessionContext } from "./sessions";
import { users } from "./schema";

/** Staff as shown in the app. Never includes the PIN hash. */
export type StaffMember = { id: string; name: string; phone: string; role: RoleName; isActive: boolean };

const staffColumns = { id: users.id, name: users.name, phone: users.phone, role: users.role, isActive: users.isActive };

const newStaffSchema = z.object({
  name: z.string().trim().min(2, "Enter the person's name.").max(80),
  phone: phoneSchema,
  role: z.enum(["manager", "cashier", "inventory"], { error: "Choose a role." }),
});

function toStaff(row: { id: string; name: string; phone: string; role: string; isActive: boolean }): StaffMember {
  return { ...row, role: row.role as RoleName };
}

/** Every query is filtered by the session's shop, so IDs from another shop look like "not found". */
export async function listStaff(session: SessionContext): Promise<StaffMember[]> {
  await requirePermission(session, "staff.manage");
  const rows = await getDb().select(staffColumns).from(users).where(eq(users.shopId, session.shopId)).orderBy(asc(users.name));
  return rows.map(toStaff);
}

export async function getStaffMember(session: SessionContext, userId: string): Promise<StaffMember> {
  await requirePermission(session, "staff.manage");
  const [row] = await getDb()
    .select(staffColumns)
    .from(users)
    .where(and(eq(users.id, userId), eq(users.shopId, session.shopId)))
    .limit(1);
  if (!row) throw new NotFoundError("Staff member not found.");
  return toStaff(row);
}

export async function addStaffMember(session: SessionContext, input: unknown): Promise<StaffMember> {
  await requirePermission(session, "staff.manage");
  const data = newStaffSchema.parse(input);
  return withTransaction(async (tx) => {
    const [row] = await tx
      .insert(users)
      .values({ shopId: session.shopId, name: data.name, phone: data.phone, role: data.role })
      .onConflictDoNothing()
      .returning(staffColumns);
    if (!row) throw new ConflictError("PHONE_IN_USE", "Someone in this shop already uses that mobile number.");
    await recordAudit(tx, { shopId: session.shopId, userId: session.userId, role: session.role }, {
      action: "identity.staff_added",
      entityType: "user",
      entityId: row.id,
      after: { name: row.name, role: row.role },
    });
    return toStaff(row);
  });
}

/** Deactivating someone also signs them out everywhere. The owner cannot be deactivated. */
export async function setStaffActive(session: SessionContext, userId: string, active: boolean): Promise<void> {
  await requirePermission(session, "staff.manage");
  if (userId === session.userId) throw new ForbiddenError("You can't deactivate your own account.");
  await withTransaction(async (tx: Transaction) => {
    const [row] = await tx
      .update(users)
      .set({ isActive: active })
      .where(and(eq(users.id, userId), eq(users.shopId, session.shopId)))
      .returning({ id: users.id, role: users.role });
    if (!row) throw new NotFoundError("Staff member not found.");
    if (row.role === "owner") throw new ForbiddenError("The owner account can't be deactivated.");
    if (!active) await revokeAllSessionsForUser(tx, userId);
    await recordAudit(tx, { shopId: session.shopId, userId: session.userId, role: session.role }, {
      action: active ? "identity.staff_activated" : "identity.staff_deactivated",
      entityType: "user",
      entityId: userId,
    });
  });
}
