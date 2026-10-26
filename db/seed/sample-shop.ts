/**
 * DEVELOPMENT SEED — fictional sample shop "Sharma Sanitary & Hardware", Jaipur.
 *
 * Safe to run repeatedly: every row has a stable ID (UUID v5 from a fixed namespace) and is
 * inserted with ON CONFLICT DO NOTHING, so a second run adds nothing.
 *
 * It writes no sales, payments or purchases. Opening stock and opening balances are recorded the
 * way the architecture requires — as `opening` stock movements and ledger entries — and the
 * stock_levels / party_balances caches are rebuilt from those journals, never typed in.
 *
 * Refuses to run unless NODE_ENV is not "production", SEED_ALLOW is "true", and the database
 * host is localhost. Product brands are real; people, phones and the GSTIN are fictional.
 * HSN codes and GST rates are typical values for these goods — confirm with the shop's CA.
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { v5 as uuidv5, v7 as uuidv7 } from "uuid";
import { DEFAULT_UNITS } from "@/modules/catalog/units";
import * as schema from "@/server/schema";
import { isLocalDatabase } from "@/server/env";
import { defaultPermissionRows } from "./permissions";

const NAMESPACE = "6f1c3a52-9a7e-4b8e-8f3d-2b1e5c9a0d11";
const sid = (key: string) => uuidv5(key, NAMESPACE);

const FY = "26-27";
const GO_LIVE_DATE = "2026-10-01";

const SHOP_ID = sid("shop:sharma-sanitary");
const OWNER_ID = sid("user:owner");

const USERS = [
  { key: "owner", name: "Rakesh Sharma", phone: "9000000001", role: "owner" },
  { key: "manager", name: "Rohit Meena", phone: "9000000002", role: "manager" },
  { key: "cashier-1", name: "Amit Saini", phone: "9000000003", role: "cashier" },
  { key: "cashier-2", name: "Priya Jain", phone: "9000000004", role: "cashier" },
  { key: "inventory", name: "Sunil Yadav", phone: "9000000005", role: "inventory" },
] as const;

const CATEGORIES = ["Pipes", "Fittings", "Valves", "Faucets", "Sanitaryware", "Cement", "Accessories"] as const;

type SeedProduct = {
  sku: string;
  barcode: string;
  name: string;
  category: (typeof CATEGORIES)[number];
  baseUnit: string;
  hsn: string;
  gstRateBp: number;
  costPaise: number | null;
  retailPaise: number;
  wholesalePaise: number;
  reorderLevel: string;
  openingStock: string;
  units?: { unit: string; factor: string }[];
  slabs?: { minQty: string; pricePaise: number }[];
};

const PRODUCTS: SeedProduct[] = [
  { sku: "AST-CP-1", barcode: "8901234500011", name: 'Astral CPVC Pipe 1" (3 m)', category: "Pipes", baseUnit: "pc", hsn: "3917", gstRateBp: 1800, costPaise: 40200, retailPaise: 54000, wholesalePaise: 47000, reorderLevel: "100", openingStock: "102", units: [{ unit: "bundle", factor: "10" }], slabs: [{ minQty: "50", pricePaise: 45500 }, { minQty: "100", pricePaise: 44000 }] },
  { sku: "SUP-EL-1", barcode: "8901234500028", name: 'Supreme PVC Elbow 1"', category: "Fittings", baseUnit: "pc", hsn: "3917", gstRateBp: 1800, costPaise: 2200, retailPaise: 3800, wholesalePaise: 3100, reorderLevel: "500", openingStock: "1914", units: [{ unit: "box", factor: "50" }], slabs: [{ minQty: "100", pricePaise: 2800 }] },
  { sku: "ASH-BV-075", barcode: "8901234500035", name: 'Ashirvad Ball Valve ¾"', category: "Valves", baseUnit: "pc", hsn: "8481", gstRateBp: 1800, costPaise: 22800, retailPaise: 32000, wholesalePaise: 27500, reorderLevel: "25", openingStock: "28", units: [{ unit: "box", factor: "10" }], slabs: [{ minQty: "50", pricePaise: 26500 }] },
  { sku: "JAQ-PC-CON", barcode: "8901234500042", name: "Jaquar Pillar Cock Continental", category: "Faucets", baseUnit: "pc", hsn: "8481", gstRateBp: 1800, costPaise: 148000, retailPaise: 185000, wholesalePaise: 162000, reorderLevel: "10", openingStock: "3" },
  // Cost price deliberately missing: profit for this item must show as "not available".
  { sku: "HIN-WB-22", barcode: "8901234500059", name: 'Hindware Wash Basin 22"', category: "Sanitaryware", baseUnit: "pc", hsn: "6910", gstRateBp: 1800, costPaise: null, retailPaise: 240000, wholesalePaise: 205000, reorderLevel: "6", openingStock: "4" },
  { sku: "ULT-50", barcode: "8901234500066", name: "UltraTech Cement 50 kg", category: "Cement", baseUnit: "bag", hsn: "2523", gstRateBp: 2800, costPaise: 36500, retailPaise: 42000, wholesalePaise: 39500, reorderLevel: "80", openingStock: "186", slabs: [{ minQty: "100", pricePaise: 38800 }] },
  { sku: "TEF-12", barcode: "8901234500073", name: "Teflon Tape 12 mm (box of 10)", category: "Accessories", baseUnit: "box", hsn: "3919", gstRateBp: 1800, costPaise: 7000, retailPaise: 12000, wholesalePaise: 9500, reorderLevel: "20", openingStock: "46" },
  { sku: "FIN-SC-237", barcode: "8901234500080", name: "Finolex CPVC Solvent Cement 237 ml", category: "Accessories", baseUnit: "pc", hsn: "3506", gstRateBp: 1800, costPaise: 16800, retailPaise: 24000, wholesalePaise: 20500, reorderLevel: "30", openingStock: "46", units: [{ unit: "box", factor: "24" }], slabs: [{ minQty: "24", pricePaise: 19800 }] },
];

/** Opening balance = what the customer owed at go-live; `since` is the oldest unpaid bill date (for ageing). */
const CUSTOMERS = [
  { key: "walkin", name: "Walk-in customer", phone: null, type: "walkin", area: null, creditLimitPaise: 0, openingPaise: 0, since: GO_LIVE_DATE },
  { key: "gupta", name: "Gupta Builders", phone: "9000001001", type: "wholesale", area: "Vaishali Nagar", creditLimitPaise: 10_000_000, openingPaise: 6_200_000, since: "2026-09-10" },
  { key: "mehta", name: "Mehta Constructions", phone: "9000001002", type: "wholesale", area: "Malviya Nagar", creditLimitPaise: 15_000_000, openingPaise: 5_400_000, since: "2026-09-17" },
  { key: "shreeram", name: "Shree Ram Plumbing Works", phone: "9000001003", type: "wholesale", area: "Sanganer", creditLimitPaise: 6_000_000, openingPaise: 3_000_000, since: "2026-09-22" },
  { key: "verma", name: "Verma Interiors", phone: "9000001004", type: "retail", area: "C-Scheme", creditLimitPaise: 3_000_000, openingPaise: 1_840_000, since: "2026-09-25" },
  { key: "anil", name: "Anil Kumar (Plumber)", phone: "9000001005", type: "retail", area: "Jhotwara", creditLimitPaise: 1_500_000, openingPaise: 425_000, since: "2026-09-28" },
] as const;

/** Opening balance = what the shop owed the supplier at go-live. */
const SUPPLIERS = [
  { key: "astral", name: "Astral Distributors (sample)", phone: "9000002001", paymentTermsDays: 30, openingPaise: 12_000_000 },
  { key: "supreme", name: "Supreme Pipes Jaipur (sample)", phone: "9000002002", paymentTermsDays: 30, openingPaise: 2_280_000 },
  { key: "jaquar", name: "Jaquar Dealer – Raja Park (sample)", phone: "9000002003", paymentTermsDays: 45, openingPaise: 4_650_000 },
] as const;

function assertSafeToSeed(url: string) {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed: NODE_ENV is production.");
  if (process.env.SEED_ALLOW !== "true") throw new Error('Refusing to seed: set SEED_ALLOW="true" in your local .env.');
  if (!url) throw new Error("Refusing to seed: DATABASE_MIGRATION_URL or DATABASE_URL is not set.");
  if (!isLocalDatabase(url)) throw new Error("Refusing to seed: the database host is not localhost.");
}

async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL ?? "";
  assertSafeToSeed(url);

  const pool = new Pool({ connectionString: url, max: 1, application_name: "nexora-seed" });
  const db = drizzle(pool, { schema });

  try {
    await db.transaction(async (tx) => {
      const [newShop] = await tx
        .insert(schema.shops)
        .values({
          id: SHOP_ID,
          name: "Sharma Sanitary & Hardware",
          legalName: "Sharma Sanitary & Hardware (sample business)",
          gstin: "08AAAAA0000A1Z5", // fictional placeholder
          stateCode: "08",
          address: "Sample address, Jaipur, Rajasthan",
          phone: "9000000001",
          fyStartMonth: 4,
          openingCashPaise: 500_000,
          settings: { timezone: "Asia/Kolkata", overdueAfterDays: 30, sample: true },
        })
        .onConflictDoNothing()
        .returning({ id: schema.shops.id });

      await tx
        .insert(schema.users)
        .values(USERS.map((user) => ({ id: sid(`user:${user.key}`), shopId: SHOP_ID, name: user.name, phone: user.phone, role: user.role })))
        .onConflictDoNothing();

      await tx
        .insert(schema.rolePermissions)
        .values(defaultPermissionRows().map((row) => ({ shopId: SHOP_ID, ...row })))
        .onConflictDoNothing();

      await tx
        .insert(schema.devices)
        .values(["Counter 1", "Counter 2", "Wholesale desk"].map((name) => ({ id: sid(`device:${name}`), shopId: SHOP_ID, name })))
        .onConflictDoNothing();

      await tx
        .insert(schema.numberSeries)
        .values(["INV", "CN", "RCPT", "PO", "GRN", "ADJ"].map((series) => ({ shopId: SHOP_ID, series, fy: FY })))
        .onConflictDoNothing();

      await tx
        .insert(schema.units)
        .values(DEFAULT_UNITS.map((unit) => ({ id: sid(`unit:${unit.code}`), shopId: SHOP_ID, ...unit })))
        .onConflictDoNothing();

      await tx
        .insert(schema.categories)
        .values(CATEGORIES.map((name) => ({ id: sid(`category:${name}`), shopId: SHOP_ID, name })))
        .onConflictDoNothing();

      await tx
        .insert(schema.products)
        .values(
          PRODUCTS.map((product) => ({
            id: sid(`product:${product.sku}`),
            shopId: SHOP_ID,
            sku: product.sku,
            barcode: product.barcode,
            name: product.name,
            categoryId: sid(`category:${product.category}`),
            baseUnit: product.baseUnit,
            hsn: product.hsn,
            gstRateBp: product.gstRateBp,
            costPaise: product.costPaise,
            retailPaise: product.retailPaise,
            wholesalePaise: product.wholesalePaise,
            reorderLevel: product.reorderLevel,
          })),
        )
        .onConflictDoNothing();

      const units = PRODUCTS.flatMap((product) =>
        (product.units ?? []).map((unit) => ({ id: sid(`unit:${product.sku}:${unit.unit}`), productId: sid(`product:${product.sku}`), ...unit })),
      );
      if (units.length) await tx.insert(schema.productUnits).values(units).onConflictDoNothing();

      const slabs = PRODUCTS.flatMap((product) =>
        (product.slabs ?? []).map((slab) => ({ id: sid(`slab:${product.sku}:${slab.minQty}`), shopId: SHOP_ID, productId: sid(`product:${product.sku}`), ...slab })),
      );
      if (slabs.length) await tx.insert(schema.priceSlabs).values(slabs).onConflictDoNothing();

      await tx
        .insert(schema.customers)
        .values(
          CUSTOMERS.map((customer) => ({
            id: sid(`customer:${customer.key}`),
            shopId: SHOP_ID,
            name: customer.name,
            phone: customer.phone,
            type: customer.type,
            area: customer.area,
            creditLimitPaise: customer.creditLimitPaise,
          })),
        )
        .onConflictDoNothing();

      await tx
        .insert(schema.customerPriceRules)
        .values([
          { id: sid("rule:gupta:all"), shopId: SHOP_ID, customerId: sid("customer:gupta"), productId: null, kind: "pct", value: 100 },
          { id: sid("rule:mehta:AST-CP-1"), shopId: SHOP_ID, customerId: sid("customer:mehta"), productId: sid("product:AST-CP-1"), kind: "fixed", value: 43000, minQty: "100" },
          { id: sid("rule:shreeram:SUP-EL-1"), shopId: SHOP_ID, customerId: sid("customer:shreeram"), productId: sid("product:SUP-EL-1"), kind: "pct", value: 200 },
        ])
        .onConflictDoNothing();

      await tx
        .insert(schema.suppliers)
        .values(SUPPLIERS.map((supplier) => ({ id: sid(`supplier:${supplier.key}`), shopId: SHOP_ID, name: supplier.name, phone: supplier.phone, paymentTermsDays: supplier.paymentTermsDays })))
        .onConflictDoNothing();

      // Opening stock: one `opening` movement per product (journal), never a direct stock edit.
      await tx
        .insert(schema.stockMovements)
        .values(
          PRODUCTS.map((product) => ({
            shopId: SHOP_ID,
            productId: sid(`product:${product.sku}`),
            movementDate: GO_LIVE_DATE,
            kind: "opening" as const,
            qtyBase: product.openingStock,
            unitCostPaise: product.costPaise,
            sourceType: "opening_stock",
            sourceId: sid(`opening-stock:${GO_LIVE_DATE}`),
            reason: "Opening stock at go-live (sample)",
            createdBy: OWNER_ID,
          })),
        )
        .onConflictDoNothing();

      // Opening balances: customer owes = debit; shop owes supplier = credit.
      await tx
        .insert(schema.ledgerEntries)
        .values([
          ...CUSTOMERS.filter((customer) => customer.openingPaise > 0).map((customer) => ({
            shopId: SHOP_ID,
            partyType: "customer" as const,
            partyId: sid(`customer:${customer.key}`),
            entryDate: customer.since,
            kind: "opening" as const,
            sourceType: "opening_balance",
            sourceId: sid(`opening-balance:customer:${customer.key}`),
            debitPaise: customer.openingPaise,
          })),
          ...SUPPLIERS.map((supplier) => ({
            shopId: SHOP_ID,
            partyType: "supplier" as const,
            partyId: sid(`supplier:${supplier.key}`),
            entryDate: GO_LIVE_DATE,
            kind: "opening" as const,
            sourceType: "opening_balance",
            sourceId: sid(`opening-balance:supplier:${supplier.key}`),
            creditPaise: supplier.openingPaise,
          })),
        ])
        .onConflictDoNothing();

      // Caches are rebuilt from the journals (the source of truth), so they always agree.
      await tx.execute(sql`
        insert into stock_levels (product_id, shop_id, qty_base, last_movement_id)
        select product_id, shop_id, sum(qty_base), max(id) from stock_movements
        where shop_id = ${SHOP_ID} group by product_id, shop_id
        on conflict (product_id) do update
          set qty_base = excluded.qty_base, last_movement_id = excluded.last_movement_id, updated_at = now()`);
      await tx.execute(sql`
        insert into party_balances (party_type, party_id, shop_id, balance_paise, last_entry_id)
        select party_type, party_id, shop_id, sum(debit_paise - credit_paise), max(id) from ledger_entries
        where shop_id = ${SHOP_ID} group by party_type, party_id, shop_id
        on conflict (party_type, party_id) do update
          set balance_paise = excluded.balance_paise, last_entry_id = excluded.last_entry_id, updated_at = now()`);

      if (newShop) {
        await tx.insert(schema.auditLog).values({
          shopId: SHOP_ID,
          action: "seed.sample_shop",
          entityType: "shop",
          entityId: SHOP_ID,
          after: { products: PRODUCTS.length, customers: CUSTOMERS.length, suppliers: SUPPLIERS.length, runId: uuidv7() },
          reason: "Development seed",
        });
      }
    });

    const counts = await db.execute<{ table: string; rows: number }>(sql`
      select 'products' as table, count(*)::int as rows from products where shop_id = ${SHOP_ID}
      union all select 'customers', count(*)::int from customers where shop_id = ${SHOP_ID}
      union all select 'suppliers', count(*)::int from suppliers where shop_id = ${SHOP_ID}
      union all select 'stock_movements', count(*)::int from stock_movements where shop_id = ${SHOP_ID}
      union all select 'ledger_entries', count(*)::int from ledger_entries where shop_id = ${SHOP_ID}`);
    console.log("Seeded sample shop (repeat runs add nothing):");
    for (const row of counts.rows) console.log(`  ${row.table}: ${row.rows}`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
