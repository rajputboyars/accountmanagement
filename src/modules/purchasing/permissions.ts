/**
 * Purchasing permissions, from the default matrix (src/shared/permissions.ts; spec §1):
 * - See suppliers, dues, orders and receipts: `purchases.view` (owner, manager, inventory staff).
 * - Add or edit suppliers and record purchase orders: `purchases.edit` (owner, manager, inventory staff).
 * - Receive goods: `stock.receive` (owner, manager, inventory staff).
 * - Pay suppliers or reverse a supplier payment: `suppliers.pay` (owner).
 * - Cancel a receipt or an order, close a short delivery: `purchases.cancel` (owner).
 * - See cost prices outside purchasing screens stays `profit.view`.
 */
export const PURCHASES_VIEW = "purchases.view" as const;
export const PURCHASES_EDIT = "purchases.edit" as const;
export const STOCK_RECEIVE = "stock.receive" as const;
export const SUPPLIERS_PAY = "suppliers.pay" as const;
export const PURCHASES_CANCEL = "purchases.cancel" as const;
