import { eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import { NotFoundError } from "@/server/errors";
import type { SessionContext } from "@/modules/identity";
import { shops } from "./schema";

export type ShopSummary = { id: string; name: string; stateCode: string };

/** The signed-in user's own shop. The shop ID always comes from the session. */
export async function getCurrentShop(session: Pick<SessionContext, "shopId">): Promise<ShopSummary> {
  const [row] = await getDb()
    .select({ id: shops.id, name: shops.name, stateCode: shops.stateCode })
    .from(shops)
    .where(eq(shops.id, session.shopId))
    .limit(1);
  if (!row) throw new NotFoundError("Shop not found.");
  return row;
}
