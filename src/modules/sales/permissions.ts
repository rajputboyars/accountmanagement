/**
 * Billing permissions, from the default matrix (src/shared/permissions.ts):
 * create bills `billing.create` (owner, manager, cashier); see bills `billing.view` (same);
 * cancel a bill `invoice.cancel` (owner only, same day, decision 20).
 */
export const BILLING_CREATE = "billing.create" as const;
export const BILLING_VIEW = "billing.view" as const;
export const INVOICE_CANCEL = "invoice.cancel" as const;
