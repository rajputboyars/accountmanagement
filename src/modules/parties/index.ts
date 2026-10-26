import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb, type Database, type Transaction } from "@/server/db";
import { NotFoundError } from "@/server/errors";
import { customers, CUSTOMER_TYPES } from "./schema";

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
