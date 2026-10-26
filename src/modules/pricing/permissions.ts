import { hasPermission, type SessionContext } from "@/modules/identity";
import { ForbiddenError } from "@/server/errors";

/**
 * Pricing permissions, from the default matrix (src/shared/permissions.ts):
 * - Changing slabs and customer rules needs `pricing.edit` (owner only by default; spec §1
 *   "Edit prices, slabs, customer rules": owner only).
 * - A price quote is read-only. Billing staff will need it at the counter, so `billing.create`
 *   or `pricing.edit` may ask for one.
 * - Cost prices and margins need `profit.view` (owner).
 */
export const PRICING_MANAGE = "pricing.edit" as const;
export const COST_VIEW = "profit.view" as const;

export async function requireQuotePermission(session: SessionContext): Promise<void> {
  if ((await hasPermission(session, "billing.create")) || (await hasPermission(session, PRICING_MANAGE))) return;
  throw new ForbiddenError();
}
