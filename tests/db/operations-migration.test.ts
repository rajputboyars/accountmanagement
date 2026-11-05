import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, describe, expect, it, inject } from "vitest";

/**
 * Migration 0030 (orders, challans, reservations, purchase returns) on a database that already holds stock and journals:
 * purely additive, so every existing row must be untouched, the new tables empty, and the new rules in force.
 */
const folders: string[] = [];
const names: string[] = [];
const pools: Pool[] = [];
let admin: Pool | undefined;

afterAll(async () => {
  for (const pool of pools) await pool.end().catch(() => undefined);
  for (const name of names) await admin?.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
  await admin?.end();
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

function migrationsThrough(last: number): string {
  const folder = mkdtempSync(join(tmpdir(), "nexora-ops-"));
  folders.push(folder);
  mkdirSync(join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync("db/migrations/meta/_journal.json", "utf8")) as { entries: { idx: number; tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= last);
  for (const entry of journal.entries) copyFileSync(join("db/migrations", `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify(journal));
  return folder;
}

const tables = ["stock_movements", "stock_levels", "godowns", "goods_receipts", "ledger_entries", "journals", "journal_lines", "accounts", "audit_log", "products"];
const checksum = async (pool: Pool) => {
  const result: Record<string, string> = {};
  for (const table of tables) {
    const row = await pool.query(`select count(*)::int as n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as h from ${table} t`);
    result[table] = `${row.rows[0].n}:${row.rows[0].h}`;
  }
  return result;
};

describe("migration 0030 on populated data", () => {
  it("changes nothing that exists, adds empty tables, and puts the new rules in force", async () => {
    const pg = inject("pg");
    const url = (database: string) => `postgres://nexora_owner:${pg.ownerPassword}@${pg.host}:${pg.port}/${database}`;
    admin = new Pool({ connectionString: url("postgres"), max: 1 });
    const name = `ops_${randomBytes(6).toString("hex")}`;
    names.push(name);
    await admin.query(`CREATE DATABASE "${name}"`);
    const pool = new Pool({ connectionString: url(name), max: 2 });
    pools.push(pool);
    await migrate(drizzle(pool), { migrationsFolder: migrationsThrough(29) });

    const shop = randomUUID();
    const user = randomUUID();
    const product = randomUUID();
    await pool.query("insert into shops (id, name, state_code) values ($1, 'Ops', '08')", [shop]);
    await pool.query("insert into users (id, shop_id, name, phone, role) values ($1, $2, 'Owner', '9000000601', 'owner')", [user, shop]);
    await pool.query("insert into units (id, shop_id, code, name) values (gen_random_uuid(), $1, 'pc', 'Piece')", [shop]);
    await pool.query("insert into products (id, shop_id, sku, name, base_unit, hsn, gst_rate_bp, retail_paise, wholesale_paise) values ($1, $2, 'OP-1', 'Pipe', 'pc', '3917', 1800, 100, 90)", [product, shop]);
    const godown = (await pool.query("insert into godowns (id, shop_id, name, is_default) values (gen_random_uuid(), $1, 'Main Store', true) returning id", [shop])).rows[0].id;
    const movement = (await pool.query("insert into stock_movements (shop_id, product_id, godown_id, movement_date, kind, qty_base, source_type, source_id, created_by) values ($1, $2, $3, '2026-10-01', 'opening', 40, 'opening_stock', gen_random_uuid(), $4) returning id", [shop, product, godown, user])).rows[0].id;
    await pool.query("insert into stock_levels (product_id, godown_id, shop_id, qty_base, last_movement_id) values ($1, $2, $3, 40, $4)", [product, godown, shop, movement]);
    await pool.query("insert into ledger_entries (shop_id, party_type, party_id, entry_date, kind, source_type, source_id, debit_paise) values ($1, 'customer', gen_random_uuid(), '2026-10-01', 'opening', 'opening_balance', gen_random_uuid(), 500)", [shop]);
    const before = await checksum(pool);

    await migrate(drizzle(pool), { migrationsFolder: migrationsThrough(30) });
    expect(await checksum(pool)).toEqual(before);

    for (const table of ["purchase_returns", "purchase_return_lines", "sales_orders", "sales_order_lines", "delivery_challans", "delivery_challan_lines", "invoice_challan_links", "stock_reservations"]) {
      expect((await pool.query(`select count(*)::int as n from ${table}`)).rows[0].n, table).toBe(0);
    }
    const column = (await pool.query("select column_default, is_nullable from information_schema.columns where table_name = 'invoices' and column_name = 'from_challans'")).rows[0];
    expect(column).toMatchObject({ column_default: "false", is_nullable: "NO" });

    // New movement kinds are accepted, old rules still hold, and the history is still append-only.
    await pool.query("insert into stock_movements (shop_id, product_id, godown_id, movement_date, kind, qty_base, source_type, source_id, created_by) values ($1, $2, $3, '2026-10-02', 'delivery', -5, 'delivery_challan', gen_random_uuid(), $4)", [shop, product, godown, user]);
    await expect(pool.query("insert into stock_movements (shop_id, product_id, godown_id, movement_date, kind, qty_base, source_type, source_id, created_by) values ($1, $2, $3, '2026-10-02', 'bogus', -5, 'x', gen_random_uuid(), $4)", [shop, product, godown, user])).rejects.toThrow(/kind_check/);
    await expect(pool.query("update stock_movements set qty_base = 1")).rejects.toThrow(/append-only/);

    // Reservations are a working table; documents are not.
    const order = randomUUID();
    await pool.query("insert into stock_reservations (id, shop_id, order_id, order_line_id, product_id, godown_id, qty_base) values (gen_random_uuid(), $1, $2, $3, $4, $5, 5)", [shop, order, randomUUID(), product, godown]);
    await expect(pool.query("insert into stock_reservations (id, shop_id, order_id, order_line_id, product_id, godown_id, qty_base) values (gen_random_uuid(), $1, $2, $3, $4, $5, 0)", [shop, order, randomUUID(), product, godown])).rejects.toThrow(/qty_check/);
    await expect(pool.query("delete from stock_reservations")).resolves.toBeDefined();
    await expect(pool.query("update purchase_returns set reason = 'x'")).resolves.toBeDefined(); // no rows yet: the append-only trigger fires per row
    await expect(pool.query("update delivery_challans set status = 'delivered'")).resolves.toBeDefined();
  });
});
