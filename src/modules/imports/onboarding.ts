import { listShopProductsForStock } from "@/modules/catalog";
import { isOwnerPinSet, listStaff, requirePermission, type SessionContext } from "@/modules/identity";
import { stockOnHand } from "@/modules/inventory";
import { listShopCustomers, listShopSuppliers } from "@/modules/parties";
import { recentInvoices } from "@/modules/sales";
import { getBusinessSettings } from "@/modules/settings";

/**
 * Go-live checklist for the owner (spec §8): worked out from the shop's real records every time, never
 * stored, so it can't drift. Each step links to the screen (or import) that completes it.
 */
export type OnboardingStep = { key: string; title: string; detail: string; done: boolean; href: string; importType?: "products" | "customers" | "suppliers" | "opening_stock" };

export async function getOnboardingStatus(session: SessionContext) {
  await requirePermission(session, "import.run");
  const [business, pinSet, staff, items, customers, suppliers, bills] = await Promise.all([
    getBusinessSettings(session),
    isOwnerPinSet(session),
    listStaff(session),
    listShopProductsForStock(session.shopId, { includeInactive: true }),
    listShopCustomers(session.shopId, { includeInactive: true }),
    listShopSuppliers(session.shopId, { includeInactive: true }),
    recentInvoices(session.shopId, 1),
  ]);
  const stocked = (await stockOnHand(session.shopId, items.map((item) => item.id))).size;
  const registered = customers.filter((customer) => customer.type !== "walkin").length;
  const shop = business.profile;
  // A regular GST-registered shop can't issue a valid tax invoice without its GSTIN on it.
  const gstReady = business.gst.registration !== "regular" || Boolean(business.gst.gstin);
  const shopReady = Boolean(shop.legalName && shop.address && shop.phone) && gstReady;
  const steps: OnboardingStep[] = [
    { key: "shop", title: "Shop details & GST", detail: shopReady ? "Name, address, phone and GST details are set." : gstReady ? "Add the legal name, address and phone printed on bills." : "Add the shop's GSTIN in Settings → GST (needed on every tax invoice).", done: shopReady, href: "/settings" },
    { key: "pin", title: "Owner PIN", detail: pinSet ? "Set. Staff need it for approvals on the spot." : "Set a PIN for approvals at the counter.", done: pinSet, href: "/settings" },
    { key: "staff", title: "Staff accounts", detail: staff.length > 1 ? `${staff.length - 1} staff added.` : "Add your cashier, manager or stock person.", done: staff.length > 1, href: "/settings" },
    { key: "products", title: "Products", detail: items.length ? `${items.length} products.` : "Add products one by one or import a CSV.", done: items.length > 0, href: "/inventory", importType: "products" },
    { key: "opening", title: "Opening stock", detail: items.length ? `${stocked} of ${items.length} products have stock entered.` : "Add products first.", done: items.length > 0 && stocked > 0, href: "/inventory/stock/opening", importType: "opening_stock" },
    { key: "customers", title: "Customers and old dues", detail: registered ? `${registered} customers.` : "Add customers with what they owe at go-live.", done: registered > 0, href: "/customers", importType: "customers" },
    { key: "suppliers", title: "Suppliers", detail: suppliers.length ? `${suppliers.length} suppliers.` : "Add the suppliers you buy from.", done: suppliers.length > 0, href: "/suppliers", importType: "suppliers" },
    { key: "bill", title: "First bill", detail: bills.length ? "Billing is running." : "Make a test bill at the counter.", done: bills.length > 0, href: "/billing" },
  ];
  const done = steps.filter((step) => step.done).length;
  return { steps, done, total: steps.length, complete: done === steps.length };
}
