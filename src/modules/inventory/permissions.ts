/**
 * Inventory permissions, from the default matrix (src/shared/permissions.ts):
 * - See stock and its history: `inventory.view` (owner, manager, inventory staff).
 * - Enter go-live opening stock: `stock.opening` (owner).
 * - Record a return, damage or count fix: `stock.adjust` (owner, manager, inventory staff); one worth
 *   more than ₹2,000 at cost, or of a product with no cost price, needs the owner (spec §7).
 * - See costs: `profit.view` (owner).
 */
export const STOCK_VIEW = "inventory.view" as const;
export const STOCK_OPENING = "stock.opening" as const;
export const STOCK_ADJUST = "stock.adjust" as const;
export const COST_VIEW = "profit.view" as const;

/** Spec decision 21: adjustments above ₹2,000 at cost need the owner. */
export const OWNER_APPROVAL_THRESHOLD_PAISE = 200000;
