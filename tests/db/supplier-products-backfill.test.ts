import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createProduct } from "@/modules/catalog";
import { cancelGoodsReceipt, createSupplier } from "@/modules/purchasing";
import { createTestShop, signInAs, type TestShop } from "../helpers/factories";
import { createPurchaseOrder, receiveGoods } from "../helpers/purchasing";
import { setupTestDatabase } from "../helpers/test-db";

/**
 * Migration 0025 on a database that already has purchases: the real migration file is run (table, backfill,
 * grant) against orders and receipts made through the services, after the new table is dropped.
 */
const db = setupTestDatabase();
const MIGRATION = readFileSync("db/migrations/0025_plain_nova.sql", "utf8");
const key = () => crypto.randomUUID().replace(/-/g, "");
const product = (name: string, sku: string) => ({ name, sku, barcode: "", categoryName: "", description: "", baseUnit: "pc", hsn: "3917", gstRateBp: "1800", retailPaise: "500", wholesalePaise: "450", costPaise: "100", reorderLevel: "" });
const supplier = (name: string) => ({ name, phone: "", gstin: "", paymentTermsDays: "30" });
const line = (productId: string) => ({ purchaseOrderLineId: "", productId, unit: "pc", quantity: "5", cost: "40", gstRateBp: "0" });
const direct = (supplierId: string, productId: string, bill: string) => ({ idempotencyKey: key(), purchaseOrderId: "", supplierId, supplierBillNo: bill, supplierBillDate: "", lines: [line(productId)] });

const ids: Record<string, string> = {};
let shopA: TestShop;
let shopB: TestShop;
let before: Record<string, number>;

const tables = ["products", "suppliers", "purchase_orders", "purchase_order_lines", "goods_receipts", "goods_receipt_lines", "ledger_entries", "stock_movements"];
async function counts() {
  const result: Record<string, number> = {};
  for (const table of tables) result[table] = Number((await db.ownerPool.query(`select count(*)::int as n from ${table}`)).rows[0].n);
  return result;
}
async function pairs() {
  const rows = (await db.ownerPool.query("select shop_id, supplier_id, product_id from supplier_products")).rows as { shop_id: string; supplier_id: string; product_id: string }[];
  return rows.map((row) => `${row.shop_id}|${row.supplier_id}|${row.product_id}`).sort();
}
const expected = (shop: TestShop, list: [string, string][]) => list.map(([s, p]) => `${shop.shopId}|${ids[s]}|${ids[p]}`);
async function runMigration() {
  for (const statement of MIGRATION.split("--> statement-breakpoint")) if (statement.trim()) await db.ownerPool.query(statement);
}

beforeAll(async () => {
  shopA = await createTestShop(db, "Backfill Shop A");
  shopB = await createTestShop(db, "Backfill Shop B");
  const a = (await signInAs(shopA.users.owner)).session;
  const b = (await signInAs(shopB.users.owner)).session;
  for (const [name, sku] of [["P1", "BF-1"], ["P2", "BF-2"], ["P3", "BF-3"], ["P4", "BF-4"]] as const) ids[name] = (await createProduct(a, product(name, sku))).id;
  ids.Q1 = (await createProduct(b, product("Q1", "BF-Q1"))).id;
  for (const name of ["SA", "SB", "SC"]) ids[name] = (await createSupplier(a, supplier(name))).id;
  ids.SX = (await createSupplier(b, supplier("SX"))).id;

  // SA: P1 on an order and again on a receipt (one pair, not two), P2 on a direct receipt, P3 only on a cancelled receipt.
  await createPurchaseOrder(a, { idempotencyKey: key(), supplierId: ids.SA, lines: [{ productId: ids.P1, unit: "pc", quantity: "3", cost: "40" }] });
  await receiveGoods(a, direct(ids.SA, ids.P1, "BF-A1"));
  await receiveGoods(a, direct(ids.SA, ids.P2, "BF-A2"));
  const cancelled = await receiveGoods(a, direct(ids.SA, ids.P3, "BF-A3"));
  await cancelGoodsReceipt(a, cancelled.id, { reason: "Backfill rehearsal" });
  // SB shares P1 with SA. SC has no purchases. SX is another shop's supplier.
  await receiveGoods(a, direct(ids.SB, ids.P1, "BF-B1"));
  await receiveGoods(b, direct(ids.SX, ids.Q1, "BF-X1"));

  before = await counts();
  await db.ownerPool.query("drop table supplier_products");
  await runMigration();
});

describe("migration 0025 on a database with purchase history", () => {
  it("links each supplier to exactly the products it has been ordered or received, once each", async () => {
    expect(await pairs()).toEqual(
      [...expected(shopA, [["SA", "P1"], ["SA", "P2"], ["SA", "P3"], ["SB", "P1"]]), ...expected(shopB, [["SX", "Q1"]])].sort(),
    );
  });

  it("leaves unrelated products and suppliers unlinked, and keeps shops apart", async () => {
    const all = await pairs();
    expect(all.some((pair) => pair.includes(ids.P4!))).toBe(false);
    expect(all.some((pair) => pair.includes(ids.SC!))).toBe(false);
    expect(all.filter((pair) => pair.startsWith(shopA.shopId) && pair.includes(ids.Q1!))).toEqual([]);
    expect(all.filter((pair) => pair.startsWith(shopB.shopId) && pair.includes(ids.P1!))).toEqual([]);
  });

  it("changes no existing records", async () => {
    expect(await counts()).toEqual(before);
  });

  it("enforces one link per supplier and product, and re-running the backfill adds nothing", async () => {
    const rows = await pairs();
    await db.ownerPool.query(`insert into supplier_products (id, shop_id, supplier_id, product_id) select gen_random_uuid(), shop_id, supplier_id, product_id from supplier_products on conflict (supplier_id, product_id) do nothing`);
    expect(await pairs()).toEqual(rows);
    await expect(db.ownerPool.query(`insert into supplier_products (id, shop_id, supplier_id, product_id) values (gen_random_uuid(), '${shopA.shopId}', '${ids.SA}', '${ids.P1}')`)).rejects.toThrow(/supplier_products_supplier_product_key/);
  });

  it("lets the application role use the table", async () => {
    const privileges = (await db.ownerPool.query(`select privilege_type from information_schema.role_table_grants where table_name = 'supplier_products' and grantee = 'nexora_app' order by privilege_type`)).rows.map((row) => row.privilege_type);
    expect(privileges).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
  });
});
