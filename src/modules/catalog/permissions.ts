import type { Permission } from "@/shared/permissions";

/**
 * The approved permission table has no separate catalog keys, so the catalog reuses the closest
 * existing ones (least privilege, documented in docs/setup.md):
 * - Viewing products and units: "inventory.view" (owner, manager, inventory staff).
 * - Creating or changing products, units and packaging: "pricing.edit" (owner only), because a
 *   product record carries its selling prices.
 * Cost prices are shown only with "profit.view" (owner).
 */
export const CATALOG_VIEW: Permission = "inventory.view";
export const CATALOG_MANAGE: Permission = "pricing.edit";
export const COST_VIEW: Permission = "profit.view";
