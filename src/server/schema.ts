/**
 * All tables, for the Drizzle client in src/server/db.ts. Application code must not import this
 * barrel to reach another module's tables: each module queries only its own tables through its
 * repo.ts (see CLAUDE.md "Architecture rules").
 */
export * from "@/modules/settings/schema";
export * from "@/modules/identity/schema";
export * from "@/modules/parties/schema";
export * from "@/modules/catalog/schema";
export * from "@/modules/pricing/schema";
export * from "@/modules/sales/schema";
export * from "@/modules/payments/schema";
export * from "@/modules/ledger/schema";
export * from "@/modules/inventory/schema";
export * from "@/modules/purchasing/schema";
export * from "@/modules/cashbook/schema";
export * from "@/modules/audit/schema";
export * from "@/modules/sync/schema";
export * from "@/modules/imports/schema";
