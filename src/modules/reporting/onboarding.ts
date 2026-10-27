import { CATALOG_MANAGE, shopHasProducts } from "@/modules/catalog";
import { loadPermissions, type SessionContext } from "@/modules/identity";
import { shopHasStockEntries, STOCK_OPENING } from "@/modules/inventory";
import { BILLING_CREATE, shopHasInvoices } from "@/modules/sales";
import { getCurrentShop, SETTINGS_EDIT } from "@/modules/settings";

/**
 * The first-run checklist: business details → first product → its stock → first bill (a bill
 * checks stock, so a product with no stock entered can't be sold yet). Each step is worked out
 * from the shop's real records every time (nothing is stored), so it ticks itself off as the owner
 * works and never disagrees with the data. `canAct` says whether this viewer may do the step.
 */
export type OnboardingStepKey = "business" | "product" | "stock" | "bill";
export type OnboardingStep = { key: OnboardingStepKey; done: boolean; href: string; canAct: boolean };
export type Onboarding = { steps: OnboardingStep[]; doneCount: number; complete: boolean; hasBills: boolean };

export async function getOnboarding(session: SessionContext): Promise<Onboarding> {
  const [shop, hasProducts, hasStock, hasBills, granted] = await Promise.all([getCurrentShop(session), shopHasProducts(session.shopId), shopHasStockEntries(session.shopId), shopHasInvoices(session.shopId), loadPermissions(session)]);
  const steps: OnboardingStep[] = [
    { key: "business", done: Boolean(shop.address?.trim() && shop.phone?.trim()), href: "/settings", canAct: granted.has(SETTINGS_EDIT) },
    { key: "product", done: hasProducts, href: "/inventory/new", canAct: granted.has(CATALOG_MANAGE) },
    { key: "stock", done: hasStock, href: "/inventory/stock/opening", canAct: granted.has(STOCK_OPENING) },
    { key: "bill", done: hasBills, href: "/billing", canAct: granted.has(BILLING_CREATE) },
  ];
  const doneCount = steps.filter((step) => step.done).length;
  return { steps, doneCount, complete: doneCount === steps.length, hasBills };
}
