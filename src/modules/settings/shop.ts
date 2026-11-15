import { eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import { NotFoundError } from "@/server/errors";
import type { SessionContext } from "@/modules/identity";
import { shops } from "./schema";

export type ShopSummary = { id: string; name: string; legalName: string | null; stateCode: string; gstin: string | null; address: string | null; phone: string | null };

/** The signed-in user's own shop. The shop ID always comes from the session. */
export async function getCurrentShop(session: Pick<SessionContext, "shopId">): Promise<ShopSummary> {
  const [row] = await getDb()
    .select({ id: shops.id, name: shops.name, legalName: shops.legalName, stateCode: shops.stateCode, gstin: shops.gstin, address: shops.address, phone: shops.phone })
    .from(shops)
    .where(eq(shops.id, session.shopId))
    .limit(1);
  if (!row) throw new NotFoundError("Shop not found.");
  return row;
}

/** The cash the drawer started with on the first day (handoff C13). No permission check. */
export async function shopOpeningCash(shopId: string): Promise<number> {
  const [row] = await getDb().select({ openingCashPaise: shops.openingCashPaise }).from(shops).where(eq(shops.id, shopId)).limit(1);
  return row?.openingCashPaise ?? 0;
}

/**
 * What staff may do on their own, set by the owner. A small expense or a return above these needs the owner's approval.
 * Kept inside the shop's settings, so a shop that never changes them gets the defaults.
 */
export type StaffLimits = { smallExpensePaise: number; returnLimitPaise: number };
export const DEFAULT_STAFF_LIMITS: StaffLimits = { smallExpensePaise: 50_000, returnLimitPaise: 200_000 };

export async function loadStaffLimits(shopId: string, db: Pick<ReturnType<typeof getDb>, "select"> = getDb()): Promise<StaffLimits> {
  const [row] = await db.select({ settings: shops.settings }).from(shops).where(eq(shops.id, shopId)).limit(1);
  const saved = ((row?.settings ?? {}) as { staffLimits?: Partial<StaffLimits> }).staffLimits ?? {};
  const valid = (value: unknown, fallback: number) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback);
  return { smallExpensePaise: valid(saved.smallExpensePaise, DEFAULT_STAFF_LIMITS.smallExpensePaise), returnLimitPaise: valid(saved.returnLimitPaise, DEFAULT_STAFF_LIMITS.returnLimitPaise) };
}
