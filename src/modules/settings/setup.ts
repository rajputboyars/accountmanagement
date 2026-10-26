import { count, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/modules/audit";
import { bootstrapOwner, phoneSchema } from "@/modules/identity";
import { getDb, withTransaction } from "@/server/db";
import { safeEqual } from "@/server/crypto";
import { getAuthEnv } from "@/server/env";
import { ConflictError, ForbiddenError, NotFoundError } from "@/server/errors";
import { financialYearLabel } from "@/shared/financial-year";
import { numberSeries, shops } from "./schema";

export const DOCUMENT_SERIES = ["INV", "CN", "RCPT", "PO", "GRN", "ADJ"] as const;

export const setupSchema = z.object({
  setupToken: z.string().min(1, "Enter the setup token."),
  shopName: z.string().trim().min(2, "Enter the shop name.").max(120),
  stateCode: z.string().regex(/^\d{2}$/, "Choose the state."),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "GSTIN should look like 08ABCDE1234F1Z5.")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  ownerName: z.string().trim().min(2, "Enter the owner's name.").max(80),
  ownerPhone: phoneSchema,
});

export type SetupInput = z.input<typeof setupSchema>;

export async function isSetupComplete(): Promise<boolean> {
  const [row] = await getDb().select({ shops: count() }).from(shops);
  return (row?.shops ?? 0) > 0;
}

/**
 * First-run setup: creates the shop, the owner, default permissions and this year's document
 * number series, in one transaction. Requires SETUP_TOKEN (disabled when it is not configured).
 * A transaction-scoped advisory lock makes concurrent attempts run one at a time, so exactly one
 * shop can ever be created this way.
 */
export async function runFirstTimeSetup(input: SetupInput, now: Date = new Date()): Promise<{ shopId: string; ownerId: string }> {
  const configuredToken = getAuthEnv().SETUP_TOKEN;
  if (!configuredToken) throw new NotFoundError("Setup is not enabled on this server.");
  const data = setupSchema.parse(input);
  if (!safeEqual(data.setupToken, configuredToken)) throw new ForbiddenError("The setup token is not correct.");

  return withTransaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('nexora:first-run-setup'))`);
    const [existing] = await tx.select({ shops: count() }).from(shops);
    if ((existing?.shops ?? 0) > 0) throw new ConflictError("SETUP_COMPLETE", "This Nexora server is already set up.");

    const [shop] = await tx
      .insert(shops)
      .values({ name: data.shopName, stateCode: data.stateCode, gstin: data.gstin ?? null, settings: { timezone: "Asia/Kolkata", overdueAfterDays: 30 } })
      .returning({ id: shops.id });
    const shopId = shop!.id;
    const { ownerId } = await bootstrapOwner(tx, shopId, { name: data.ownerName, phone: data.ownerPhone });
    const fy = financialYearLabel(now);
    await tx.insert(numberSeries).values(DOCUMENT_SERIES.map((series) => ({ shopId, series, fy })));
    await recordAudit(tx, { shopId, userId: ownerId, role: "owner" }, {
      action: "setup.completed",
      entityType: "shop",
      entityId: shopId,
      after: { shopName: data.shopName, stateCode: data.stateCode, fy, setupToken: data.setupToken },
    });
    return { shopId, ownerId };
  });
}
