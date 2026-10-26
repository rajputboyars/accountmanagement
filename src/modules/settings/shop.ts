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
