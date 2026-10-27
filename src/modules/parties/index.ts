import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb, type Database, type Transaction } from "@/server/db";
import { NotFoundError } from "@/server/errors";
import { customers, CUSTOMER_TYPES, suppliers } from "./schema";

/**
 * Public API of the parties module. Customer screens come in Phase 2; for now other modules only
 * need to look customers up. These helpers do not check permissions: the calling service has.
 */

export type CustomerType = (typeof CUSTOMER_TYPES)[number];
export type CustomerSummary = {
  id: string;
  name: string;
  type: CustomerType;
  area: string | null;
  phone: string | null;
  gstin: string | null;
  creditLimitPaise: number;
  whatsappConsent: boolean;
  isActive: boolean;
};

const summary = {
  id: customers.id,
  name: customers.name,
  type: customers.type,
  area: customers.area,
  phone: customers.phone,
  gstin: customers.gstin,
  creditLimitPaise: customers.creditLimitPaise,
  whatsappConsent: customers.whatsappConsent,
  isActive: customers.isActive,
};

/** One customer of `shopId`. Unknown ids and ids of another shop are "not found". */
export async function findCustomer(shopId: string, customerId: string, db: Database | Transaction = getDb()): Promise<CustomerSummary> {
  if (!/^[0-9a-f-]{36}$/i.test(customerId)) throw new NotFoundError("Customer not found.");
  const [row] = await db
    .select(summary)
    .from(customers)
    .where(and(eq(customers.shopId, shopId), eq(customers.id, customerId)))
    .limit(1);
  if (!row) throw new NotFoundError("Customer not found.");
  return row;
}

/** Active customers of `shopId`, by name. */
export async function listActiveCustomers(shopId: string, db: Database | Transaction = getDb()): Promise<CustomerSummary[]> {
  return db
    .select(summary)
    .from(customers)
    .where(and(eq(customers.shopId, shopId), eq(customers.isActive, true)))
    .orderBy(asc(customers.name));
}

/** Names of customers of `shopId`, for labelling. Ids of other shops are ignored. */
export async function loadCustomerNames(shopId: string, customerIds: string[], db: Database | Transaction = getDb()): Promise<Map<string, string>> {
  if (customerIds.length === 0) return new Map();
  const rows = await db
    .select({ id: customers.id, name: customers.name })
    .from(customers)
    .where(and(eq(customers.shopId, shopId), inArray(customers.id, customerIds)));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * The shop's "Walk-in customer" (one per shop, by a unique index), created the first time it is
 * needed. Walk-in bills must be paid in full and never touch the ledger.
 */
export async function ensureWalkInCustomer(tx: Transaction, shopId: string): Promise<CustomerSummary> {
  await tx.insert(customers).values({ id: randomUUID(), shopId, name: "Walk-in customer", type: "walkin" }).onConflictDoNothing();
  const [row] = await tx
    .select(summary)
    .from(customers)
    .where(and(eq(customers.shopId, shopId), eq(customers.type, "walkin")))
    .limit(1);
  return row!;
}

// ── Suppliers ────────────────────────────────────────────────────────────────

export type SupplierRow = { id: string; name: string; phone: string | null; gstin: string | null; paymentTermsDays: number; isActive: boolean; createdAt: Date };
const supplierColumns = { id: suppliers.id, name: suppliers.name, phone: suppliers.phone, gstin: suppliers.gstin, paymentTermsDays: suppliers.paymentTermsDays, isActive: suppliers.isActive, createdAt: suppliers.createdAt };

export async function findSupplier(shopId: string, supplierId: string, db: Database | Transaction = getDb()): Promise<SupplierRow> {
  if (!/^[0-9a-f-]{36}$/i.test(supplierId)) throw new NotFoundError("Supplier not found.");
  const [row] = await db.select(supplierColumns).from(suppliers).where(and(eq(suppliers.shopId, shopId), eq(suppliers.id, supplierId))).limit(1);
  if (!row) throw new NotFoundError("Supplier not found.");
  return row;
}

/** Names of suppliers of `shopId`, for labelling. Ids of other shops are ignored. */
export async function loadSupplierNames(shopId: string, supplierIds: string[], db: Database | Transaction = getDb()): Promise<Map<string, string>> {
  if (supplierIds.length === 0) return new Map();
  const rows = await db
    .select({ id: suppliers.id, name: suppliers.name })
    .from(suppliers)
    .where(and(eq(suppliers.shopId, shopId), inArray(suppliers.id, supplierIds)));
  return new Map(rows.map((row) => [row.id, row.name]));
}

export async function listShopSuppliers(shopId: string, options: { includeInactive?: boolean } = {}, db: Database | Transaction = getDb()): Promise<SupplierRow[]> {
  return db
    .select(supplierColumns)
    .from(suppliers)
    .where(options.includeInactive ? eq(suppliers.shopId, shopId) : and(eq(suppliers.shopId, shopId), eq(suppliers.isActive, true)))
    .orderBy(asc(suppliers.name));
}

export type SupplierFields = { name: string; phone: string | null; gstin: string | null; paymentTermsDays: number };

/** True when another supplier of the shop already has this name (case-insensitive). */
export async function supplierNameTaken(tx: Transaction, shopId: string, name: string, exceptId?: string): Promise<boolean> {
  const rows = await tx
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(and(eq(suppliers.shopId, shopId), sql`lower(${suppliers.name}) = lower(${name})`));
  return rows.some((row) => row.id !== exceptId);
}

export async function insertSupplier(tx: Transaction, shopId: string, fields: SupplierFields): Promise<string> {
  const id = randomUUID();
  await tx.insert(suppliers).values({ id, shopId, ...fields });
  return id;
}

export async function updateSupplierRow(tx: Transaction, shopId: string, supplierId: string, fields: Partial<SupplierFields> & { isActive?: boolean }): Promise<void> {
  await tx.update(suppliers).set(fields).where(and(eq(suppliers.shopId, shopId), eq(suppliers.id, supplierId)));
}

/** Locks one supplier row, so purchase and payment writes for a supplier run one at a time. */
export async function lockSupplier(tx: Transaction, shopId: string, supplierId: string): Promise<SupplierRow> {
  if (!/^[0-9a-f-]{36}$/i.test(supplierId)) throw new NotFoundError("Supplier not found.");
  const [row] = await tx.select(supplierColumns).from(suppliers).where(and(eq(suppliers.shopId, shopId), eq(suppliers.id, supplierId))).limit(1).for("update");
  if (!row) throw new NotFoundError("Supplier not found.");
  return row;
}

/** Every customer of the shop except the walk-in, by name (switched-off ones too when asked). */
export async function listShopCustomers(shopId: string, options: { includeInactive?: boolean } = {}, db: Database | Transaction = getDb()): Promise<CustomerSummary[]> {
  const rows = await db
    .select(summary)
    .from(customers)
    .where(options.includeInactive ? eq(customers.shopId, shopId) : and(eq(customers.shopId, shopId), eq(customers.isActive, true)))
    .orderBy(asc(customers.name));
  return rows.filter((row) => row.type !== "walkin");
}

export { createCustomer, customerCreateSchema, updateCustomer } from "./customers";
