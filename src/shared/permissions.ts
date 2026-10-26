/**
 * Permission keys and default role grants (docs/implementation-handoff.md §2.3).
 * Defaults are copied into role_permissions when a shop is created; the database is the
 * source of truth after that. Anything not granted there is denied.
 */
export const ROLE_NAMES = ["owner", "manager", "cashier", "inventory"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const DEFAULT_PERMISSIONS = {
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
  "payments.reverse": ["owner"], // reverse a customer receipt entered by mistake
  "inventory.view": ["owner", "manager", "inventory"],
  "purchases.view": ["owner", "manager", "inventory"],
  "purchases.edit": ["owner", "manager", "inventory"],
  "purchases.cancel": ["owner"], // cancel a goods receipt or order, close a short delivery (spec §5: owner)
  "stock.receive": ["owner", "manager", "inventory"],
  "stock.adjust": ["owner", "manager", "inventory"],
  "stock.opening": ["owner"], // go-live opening stock (spec §8: owner enters and reviews opening entries)
  "suppliers.pay": ["owner"],
  "reports.view": ["owner", "manager"],
  "profit.view": ["owner"],
  "cash.record": ["owner", "manager"],
  "day.close": ["owner"],
  "day.reopen": ["owner"],
  "staff.manage": ["owner"],
  "settings.edit": ["owner"], // business profile, GST and invoice settings
  "audit.view": ["owner"],
  "import.run": ["owner"],
  "approvals.view": ["owner", "manager", "cashier", "inventory"],
  "approvals.decide": ["owner"],
} as const satisfies Record<string, readonly RoleName[]>;

export type Permission = keyof typeof DEFAULT_PERMISSIONS;

export const PERMISSIONS = Object.keys(DEFAULT_PERMISSIONS) as Permission[];

export function isPermission(value: string): value is Permission {
  return Object.hasOwn(DEFAULT_PERMISSIONS, value);
}

/** One row per (role, permission) — explicit `false` rows make denials visible to the owner. */
export function defaultPermissionRows(): { role: RoleName; permission: Permission; allowed: boolean }[] {
  return PERMISSIONS.flatMap((permission) =>
    ROLE_NAMES.map((role) => ({
      role,
      permission,
      allowed: (DEFAULT_PERMISSIONS[permission] as readonly RoleName[]).includes(role),
    })),
  );
}
