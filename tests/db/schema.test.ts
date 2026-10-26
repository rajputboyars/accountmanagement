import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { setupTestDatabase } from "../helpers/test-db";

const db = setupTestDatabase();

/** Drizzle wraps PostgreSQL errors ("Failed query: ..."); the database message is in error.cause. */
async function expectDbError(promise: Promise<unknown>, pattern: RegExp) {
  const error = await promise.then(() => null, (e: unknown) => e as Error & { cause?: Error });
  expect(error, "expected the statement to fail").not.toBeNull();
  expect(String(error!.cause?.message ?? error!.message)).toMatch(pattern);
}

/** Runs SQL as the restricted application role (the role the app uses in production). */
async function asApp(text: string): Promise<{ ok: boolean; message?: string }> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await pool.query(text);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  } finally {
    await pool.end();
  }
}

describe("migrations and database rules", () => {
  it("applies all migrations to a fresh database", async () => {
    const tables = await db.owner.execute<{ n: number }>(sql`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`);
    expect(tables.rows[0]!.n).toBe(39);
    const applied = await db.owner.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(applied.rows[0]!.n).toBe(4);
    const views = await db.owner.execute<{ name: string }>(sql`select table_name as name from information_schema.views where table_schema = 'public' order by 1`);
    expect(views.rows.map((r) => r.name)).toEqual(["v_party_balance", "v_stock"]);
  });

  it("keeps journals append-only even for the schema owner", async () => {
    // Row-level triggers need rows to act on: write one journal entry of each kind first.
    await db.owner.execute(sql`
      with s as (insert into shops (id, name, state_code) values (gen_random_uuid(), 'J', '08') returning id),
           u as (insert into users (id, shop_id, name, phone, role) select gen_random_uuid(), id, 'O', '9000000301', 'owner' from s returning id, shop_id),
           un as (insert into units (id, shop_id, code, name) select gen_random_uuid(), id, 'pc', 'Piece' from s returning shop_id),
           p as (insert into products (id, shop_id, sku, name, base_unit, hsn, gst_rate_bp, retail_paise, wholesale_paise) select gen_random_uuid(), shop_id, 'J-1', 'Pipe', 'pc', '3917', 1800, 100, 90 from un returning id, shop_id),
           m as (insert into stock_movements (shop_id, product_id, movement_date, kind, qty_base, source_type, source_id, created_by) select p.shop_id, p.id, '2026-10-01', 'opening', 5, 'opening_stock', gen_random_uuid(), u.id from p, u returning 1)
      insert into ledger_entries (shop_id, party_type, party_id, entry_date, kind, source_type, source_id, debit_paise) select id, 'customer', gen_random_uuid(), '2026-10-01', 'opening', 'opening_balance', gen_random_uuid(), 500 from s`);
    await expectDbError(db.owner.execute(sql`update ledger_entries set debit_paise = 1`), /append-only/);
    await expectDbError(db.owner.execute(sql`delete from ledger_entries`), /append-only/);
    await expectDbError(db.owner.execute(sql`update stock_movements set qty_base = 1`), /append-only/);
    await expectDbError(db.owner.execute(sql`delete from stock_movements`), /append-only/);
    await expectDbError(db.owner.execute(sql`truncate audit_log`), /append-only/);
  });

  it("gives the app role data access but no DDL and no journal edits", async () => {
    expect(await asApp("select count(*) from users")).toEqual({ ok: true });
    expect((await asApp("update ledger_entries set debit_paise = 1")).message).toMatch(/permission denied/);
    expect((await asApp("delete from audit_log")).message).toMatch(/permission denied/);
    expect((await asApp("create table sneaky (x int)")).message).toMatch(/permission denied/);
    expect((await asApp("drop table users")).message).toMatch(/must be owner|permission denied/);
  });

  it("allows one owner per shop and only known roles", async () => {
    const shop = await db.owner.execute<{ id: string }>(sql`insert into shops (id, name, state_code) values (gen_random_uuid(), 'X', '08') returning id`);
    const shopId = shop.rows[0]!.id;
    await db.owner.execute(sql`insert into users (id, shop_id, name, phone, role) values (gen_random_uuid(), ${shopId}, 'A', '9000000101', 'owner')`);
    await expectDbError(
      db.owner.execute(sql`insert into users (id, shop_id, name, phone, role) values (gen_random_uuid(), ${shopId}, 'B', '9000000102', 'owner')`),
      /one_owner_per_shop/,
    );
    await expectDbError(
      db.owner.execute(sql`insert into users (id, shop_id, name, phone, role) values (gen_random_uuid(), ${shopId}, 'C', '9000000103', 'superuser')`),
      /users_role_check/,
    );
  });

  it("enforces the invoice total rule", async () => {
    await expectDbError(
      db.owner.execute(sql`
        with s as (insert into shops (id, name, state_code) values (gen_random_uuid(), 'Y', '08') returning id),
             u as (insert into users (id, shop_id, name, phone, role) select gen_random_uuid(), id, 'O', '9000000201', 'owner' from s returning id, shop_id),
             c as (insert into customers (id, shop_id, name, type) select gen_random_uuid(), id, 'Walk-in', 'walkin' from s returning id)
        insert into invoices (id, shop_id, fy, number, business_date, customer_id, price_list, created_by, subtotal_paise, taxable_paise, cgst_paise, sgst_paise, round_off_paise, total_paise, cost_complete)
        select gen_random_uuid(), u.shop_id, '26-27', 'INV/26-27/00001', '2026-10-25', c.id, 'retail', u.id, 100, 100, 9, 9, 0, 999, true from u, c`),
      /invoices_total_check/,
    );
  });
});
