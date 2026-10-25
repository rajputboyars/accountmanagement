import type { Role } from "@/modules/identity/schema";

/** Default role permissions from docs/implementation-handoff.md §2.3. The owner can change them later. */
export const DEFAULT_PERMISSIONS: Record<string, readonly Role[]> = {
  "billing.create": ["owner", "manager", "cashier"],
  "billing.view": ["owner", "manager", "cashier"],
  "billing.return": ["owner", "manager"],
  "invoice.edit": ["owner", "manager"], // manager needs owner approval per correction
  "invoice.cancel": ["owner"],
  "pricing.edit": ["owner"],
  "customers.view": ["owner", "manager", "cashier"],
  "customers.edit": ["owner", "manager"],
  "payments.record": ["owner", "manager", "cashier"],
  "payments.view": ["owner", "manager", "cashier"],
  "inventory.view": ["owner", "manager", "inventory"],
  "purchases.view": ["owner", "manager", "inventory"],
  "purchases.edit": ["owner", "manager", "inventory"],
  "stock.receive": ["owner", "manager", "inventory"],
  "stock.adjust": ["owner", "manager", "inventory"],
  "suppliers.pay": ["owner"],
  "reports.view": ["owner", "manager"],
  "profit.view": ["owner"],
  "cash.record": ["owner", "manager"],
  "day.close": ["owner"],
  "day.reopen": ["owner"],
  "staff.manage": ["owner"],
  "audit.view": ["owner"],
  "import.run": ["owner"],
};
