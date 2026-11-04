import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, describe, expect, it, inject } from "vitest";

/**
 * Migration 0029 (godowns) on a database that already holds stock: the real migration file is run from the state at 0028.
 * It must keep every product's quantity, movement count and cache row exactly, give each shop one Main Store, put every
 * movement and cache row in it, and abort the whole migration safely if anything differs.
 */
const names: string[] = [];
const folders: string[] = [];
const pools: Pool[] = [];
let admin: Pool | undefined;

afterAll(async () => {
  for (const pool of pools) await pool.end().catch(() => undefined);
  for (const name of names) await admin?.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
  await admin?.end();
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

function migrationsThrough(last: number, tamper?: (sql: string) => string): string {
  const folder = mkdtempSync(join(tmpdir(), "nexora-godown-"));
  folders.push(folder);
  mkdirSync(join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync("db/migrations/meta/_journal.json", "utf8")) as { entries: { idx: number; tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= last);
  for (const entry of journal.entries) {
    if (entry.idx === 29 && tamper) writeFileSync(join(folder, `${entry.tag}.sql`), tamper(readFileSync(`db/migrations/${entry.tag}.sql`, "utf8")));
    else copyFileSync(join("db/migrations", `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify(journal));
  return folder;
}

async function populatedDatabaseAt0028() {
  const pg = inject("pg");
  const url = (database: string) => `postgres://nexora_owner:${pg.ownerPassword}@${pg.host}:${pg.port}/${database}`;
  admin ??= new Pool({ connectionString: url("postgres"), max: 1 });
  const name = `godown_${randomBytes(6).toString("hex")}`;
  names.push(name);
  await admin.query(`CREATE DATABASE "${name}"`);
  const pool = new Pool({ connectionString: url(name), max: 2 });
  pools.push(pool);
  await migrate(drizzle(pool), { migrationsFolder: migrationsThrough(28) });

  const shops: { id: string; user: string }[] = [];
  for (const [index, label] of ["Alpha", "Beta", "Empty"].entries()) {
    const shop = randomUUID();
    const user = randomUUID();
    shops.push({ id: shop, user });
    await pool.query("insert into shops (id, name, state_code) values ($1, $2, '08')", [shop, label]);
    await pool.query("insert into users (id, shop_id, name, phone, role) values ($1, $2, 'Owner', $3, 'owner')", [user, shop, `90000004${index}1`]);
    await pool.query("insert into units (id, shop_id, code, name) values (gen_random_uuid(), $1, 'pc', 'Piece')", [shop]);
    if (label === "Empty") continue;
    for (let n = 1; n <= 3; n += 1) {
      const product = randomUUID();
      await pool.query("insert into products (id, shop_id, sku, name, base_unit, hsn, gst_rate_bp, retail_paise, wholesale_paise) values ($1, $2, $3, $4, 'pc', '3917', 1800, 100, 90)", [product, shop, `${label}-${n}`, `${label} product ${n}`]);
      const moves: [string, number][] = n === 1 ? [["opening", 100], ["sale", -30], ["sale_cancel", 5], ["purchase", 12.5], ["damage", -2]] : n === 2 ? [["opening", 7], ["sale", -7]] : [["opening", 4.25]];
      let last = 0;
      let total = 0;
      for (const [kind, qty] of moves) {
        const row = await pool.query("insert into stock_movements (shop_id, product_id, movement_date, kind, qty_base, source_type, source_id, created_by) values ($1, $2, '2026-10-01', $3, $4, 'test', $5, $6) returning id", [shop, product, kind, qty, randomUUID(), user]);
        last = Number(row.rows[0].id);
        total += qty;
      }
      // Product 3 of Alpha has no cache row at all (legacy), the rest are consistent: the migration must keep both as they are.
      if (!(label === "Alpha" && n === 3)) await pool.query("insert into stock_levels (product_id, shop_id, qty_base, last_movement_id) values ($1, $2, $3, $4)", [product, shop, total, last]);
    }
  }
  return { pool, shops };
}

const snapshot = async (pool: Pool) => ({
  movements: (await pool.query("select product_id, sum(qty_base)::text as qty, count(*)::int as n from stock_movements group by product_id order by product_id")).rows,
  cache: (await pool.query("select product_id, sum(qty_base)::text as qty, count(*)::int as n from stock_levels group by product_id order by product_id")).rows,
  vStock: (await pool.query("select product_id, qty_base::text as qty from v_stock order by product_id")).rows,
});

describe("migration 0029 on populated stock", () => {
  it("gives every shop a Main Store and moves all stock into it without changing a quantity, a count or a cache row", async () => {
    const { pool, shops } = await populatedDatabaseAt0028();
    const before = await snapshot(pool);
    expect(before.movements).toHaveLength(6);
    expect(before.cache).toHaveLength(5);

    await migrate(drizzle(pool), { migrationsFolder: migrationsThrough(29) });

    const after = await snapshot(pool);
    expect(after.movements).toEqual(before.movements);
    expect(after.cache).toEqual(before.cache);
    expect(after.vStock).toEqual(before.vStock);

    const stores = (await pool.query("select shop_id, name, is_default, is_active from godowns order by shop_id")).rows;
    expect(stores).toHaveLength(3);
    expect(stores.every((row) => row.name === "Main Store" && row.is_default && row.is_active)).toBe(true);
    expect(new Set(stores.map((row) => row.shop_id))).toEqual(new Set(shops.map((shop) => shop.id)));

    // Every movement and cache row is in its own shop's Main Store, and the cache still equals the journal per product.
    expect((await pool.query("select count(*)::int as n from stock_movements m join godowns g on g.id = m.godown_id where g.shop_id <> m.shop_id or not g.is_default")).rows[0].n).toBe(0);
    expect((await pool.query("select count(*)::int as n from stock_levels l join godowns g on g.id = l.godown_id where g.shop_id <> l.shop_id or not g.is_default")).rows[0].n).toBe(0);
    expect((await pool.query("select count(*)::int as n from stock_movements where godown_id is null")).rows[0].n).toBe(0);
    const drift = await pool.query("select count(*)::int as n from stock_levels l where l.qty_base <> (select sum(qty_base) from stock_movements m where m.product_id = l.product_id and m.godown_id = l.godown_id)");
    expect(drift.rows[0].n).toBe(0);

    // The history is still append-only, entered quantities are empty (never made up), and the cache is keyed by product and godown.
    await expect(pool.query("update stock_movements set qty_base = 1")).rejects.toThrow(/append-only/);
    expect((await pool.query("select count(*)::int as n from stock_movements where entered_qty is not null or entered_unit is not null or entered_factor is not null")).rows[0].n).toBe(0);
    const [level] = (await pool.query("select * from stock_levels limit 1")).rows;
    await expect(pool.query("insert into stock_levels (product_id, godown_id, shop_id, qty_base, last_movement_id) values ($1, $2, $3, 1, 1)", [level.product_id, level.godown_id, level.shop_id])).rejects.toThrow();
    const second = (await pool.query("insert into godowns (id, shop_id, name) values (gen_random_uuid(), $1, 'Shop floor') returning id", [level.shop_id])).rows[0].id;
    await pool.query("insert into stock_levels (product_id, godown_id, shop_id, qty_base, last_movement_id) values ($1, $2, $3, 1, 1)", [level.product_id, second, level.shop_id]);

    // Godowns are never deleted, a second default is refused, and only the name and active flag may change.
    await expect(pool.query("delete from godowns")).rejects.toThrow(/append-only|not allowed/);
    await expect(pool.query("insert into godowns (id, shop_id, name, is_default) values (gen_random_uuid(), $1, 'Another main', true)", [level.shop_id])).rejects.toThrow();
    await expect(pool.query("update godowns set is_default = false where is_default")).rejects.toThrow(/only the name/);
    await expect(pool.query("update godowns set is_active = false where is_default")).rejects.toThrow();
    await expect(pool.query("update godowns set name = 'Shop floor 2', is_active = false where id = $1", [second])).resolves.toBeDefined();
  });

  it("is repeatable: running the default-godown step again adds nothing", async () => {
    const { pool } = await populatedDatabaseAt0028();
    await migrate(drizzle(pool), { migrationsFolder: migrationsThrough(29) });
    const before = (await pool.query("select count(*)::int as n from godowns")).rows[0].n;
    await pool.query(`insert into godowns (id, shop_id, name, is_default, is_active) select gen_random_uuid(), id, 'Main Store', true, true from shops on conflict (shop_id) where is_default do nothing`);
    expect((await pool.query("select count(*)::int as n from godowns")).rows[0].n).toBe(before);
  });

  it("aborts the whole migration, leaving the database as it was, if any quantity or count differs", async () => {
    const { pool } = await populatedDatabaseAt0028();
    const before = await snapshot(pool);
    // A stray movement slipped in before the check: the check must catch it and the transaction must roll back.
    const tamper = (sql: string) =>
      sql.replace(
        "-- The check:",
        `INSERT INTO "stock_movements" ("shop_id", "product_id", "godown_id", "movement_date", "kind", "qty_base", "source_type", "source_id", "created_by") SELECT "shop_id", "product_id", "godown_id", "movement_date", 'count', 1, 'tamper', gen_random_uuid(), "created_by" FROM "stock_movements" LIMIT 1;--> statement-breakpoint\n-- The check:`,
      );
    await expect(migrate(drizzle(pool), { migrationsFolder: migrationsThrough(29, tamper) })).rejects.toThrow(/movement totals or counts/);
    expect(await snapshot(pool)).toEqual(before);
    expect((await pool.query("select to_regclass('public.godowns') as t")).rows[0].t).toBeNull();
    expect((await pool.query("select count(*)::int as n from information_schema.columns where table_name = 'stock_movements' and column_name = 'godown_id'")).rows[0].n).toBe(0);
    expect((await pool.query("select count(*)::int as n from pg_trigger where tgname = 'stock_movements_append_only' and tgenabled = 'O'")).rows[0].n).toBe(1);
  });
});
