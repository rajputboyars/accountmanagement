import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, describe, expect, it, inject } from "vitest";

/**
 * Migration 0031 (bank accounts, statements, matches, reconciliations) on a database that already holds payments and books: purely
 * additive. Every existing payment and journal must be untouched (the new payment column is empty), the new tables empty, and the
 * new protections in force: statements and finished reconciliations are never edited, lines only change status, matches only release.
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
  const folder = mkdtempSync(join(tmpdir(), "nexora-bank-"));
  folders.push(folder);
  mkdirSync(join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync("db/migrations/meta/_journal.json", "utf8")) as { entries: { idx: number; tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= last);
  for (const entry of journal.entries) copyFileSync(join("db/migrations", `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify(journal));
  return folder;
}

/** Row text of the columns that existed before this migration (the new payments column is left out on purpose). */
const snapshots: Record<string, string> = {
  payments: "select count(*)::int as n, coalesce(md5(string_agg(concat_ws('|', id, shop_id, fy, direction, party_type, method, amount_paise, reference, business_date, status), ',' order by id)), '') as h from payments",
  accounts: "select count(*)::int as n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as h from accounts t",
  journals: "select count(*)::int as n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as h from journals t",
  journal_lines: "select count(*)::int as n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as h from journal_lines t",
};
const snapshot = async (pool: Pool) => Object.fromEntries(await Promise.all(Object.entries(snapshots).map(async ([name, query]) => [name, JSON.stringify((await pool.query(query)).rows[0])])));

describe("migration 0031 on populated data", () => {
  it("changes nothing that exists, adds empty tables, and puts the new protections in force", async () => {
    const pg = inject("pg");
    const url = (database: string) => `postgres://nexora_owner:${pg.ownerPassword}@${pg.host}:${pg.port}/${database}`;
    admin = new Pool({ connectionString: url("postgres"), max: 1 });
    const name = `bank_${randomBytes(6).toString("hex")}`;
    names.push(name);
    await admin.query(`CREATE DATABASE "${name}"`);
    const pool = new Pool({ connectionString: url(name), max: 2 });
    pools.push(pool);
    await migrate(drizzle(pool), { migrationsFolder: migrationsThrough(30) });

    const shop = randomUUID();
    const user = randomUUID();
    await pool.query("insert into shops (id, name, state_code) values ($1, 'Bank', '08')", [shop]);
    await pool.query("insert into users (id, shop_id, name, phone, role) values ($1, $2, 'Owner', '9000000701', 'owner')", [user, shop]);
    const bankAccount = (await pool.query("insert into accounts (id, shop_id, system_key, code, name, type, category, cash_flow) values (gen_random_uuid(), $1, 'bank', '1020', 'Bank account', 'asset', 'cash_and_bank', 'cash') returning id", [shop])).rows[0].id;
    await pool.query("insert into payments (id, shop_id, fy, direction, party_type, method, amount_paise, reference, business_date, recorded_by) values (gen_random_uuid(), $1, '26-27', 'in', 'none', 'bank', 50000, 'UTR1', '2026-10-01', $2)", [shop, user]);
    const before = await snapshot(pool);

    await migrate(drizzle(pool), { migrationsFolder: migrationsThrough(31) });
    expect(await snapshot(pool)).toEqual(before);
    for (const table of ["bank_accounts", "bank_statements", "bank_statement_lines", "bank_match_groups", "bank_match_lines", "bank_match_items", "bank_reconciliations"]) {
      expect((await pool.query(`select count(*)::int as n from ${table}`)).rows[0].n, table).toBe(0);
    }
    expect((await pool.query("select count(*)::int as n from payments where bank_account_id is not null")).rows[0].n).toBe(0);

    // A bank account's identity and opening figures are fixed; its name and on/off switch can change.
    const bank = (await pool.query("insert into bank_accounts (id, shop_id, account_id, name, is_default, opening_as_of, opening_statement_paise, opening_book_paise) values (gen_random_uuid(), $1, $2, 'HDFC', true, '2026-10-01', 0, 0) returning id", [shop, bankAccount])).rows[0].id;
    await expect(pool.query("update bank_accounts set opening_statement_paise = 5")).rejects.toThrow(/only the name/);
    await expect(pool.query("update bank_accounts set name = 'HDFC Current', is_active = true")).resolves.toBeDefined();
    await expect(pool.query("delete from bank_accounts")).rejects.toThrow(/append-only|cannot/i);
    await expect(pool.query("insert into bank_accounts (id, shop_id, account_id, name, is_default, opening_as_of, opening_statement_paise, opening_book_paise) values (gen_random_uuid(), $1, $2, 'second', true, '2026-10-01', 0, 0)", [shop, bankAccount])).rejects.toThrow(/duplicate key/);

    // Statements are never edited; a line only changes status; the same line text with the same number cannot be stored twice.
    const statement = (await pool.query("insert into bank_statements (id, shop_id, bank_account_id, file_name, file_hash, line_count, new_line_count, duplicate_line_count, imported_by) values (gen_random_uuid(), $1, $2, 'a.csv', 'h1', 1, 1, 0, $3) returning id", [shop, bank, user])).rows[0].id;
    await expect(pool.query("update bank_statements set file_name = 'x'")).rejects.toThrow(/append-only/);
    await expect(pool.query("insert into bank_statements (id, shop_id, bank_account_id, file_name, file_hash, line_count, new_line_count, duplicate_line_count, imported_by) values (gen_random_uuid(), $1, $2, 'b.csv', 'h1', 1, 1, 0, $3)", [shop, bank, user])).rejects.toThrow(/duplicate key/);
    const insertLine = "insert into bank_statement_lines (id, shop_id, statement_id, bank_account_id, txn_date, narration, credit_paise, fingerprint, occurrence) values (gen_random_uuid(), $1, $2, $3, '2026-10-02', 'NEFT', 100, 'fp', 1) returning id";
    const line = (await pool.query(insertLine, [shop, statement, bank])).rows[0].id;
    await expect(pool.query(insertLine, [shop, statement, bank])).rejects.toThrow(/duplicate key/);
    await expect(pool.query("update bank_statement_lines set credit_paise = 5")).rejects.toThrow(/only the status/);
    await expect(pool.query("update bank_statement_lines set status = 'ignored', ignore_reason = 'x'")).resolves.toBeDefined();
    await expect(pool.query("update bank_statement_lines set status = 'bogus'")).rejects.toThrow(/check/);
    await expect(pool.query("delete from bank_statement_lines")).rejects.toThrow();
    await expect(pool.query("insert into bank_statement_lines (id, shop_id, statement_id, bank_account_id, txn_date, narration, debit_paise, credit_paise, fingerprint, occurrence) values (gen_random_uuid(), $1, $2, $3, '2026-10-02', 'both', 1, 1, 'fp2', 1)", [shop, statement, bank])).rejects.toThrow(/check/);

    // A line can be in only one active match; a released match is never reopened.
    const group = (await pool.query("insert into bank_match_groups (id, shop_id, bank_account_id, kind, created_by) values (gen_random_uuid(), $1, $2, 'match', $3) returning id", [shop, bank, user])).rows[0].id;
    const group2 = (await pool.query("insert into bank_match_groups (id, shop_id, bank_account_id, kind, created_by) values (gen_random_uuid(), $1, $2, 'match', $3) returning id", [shop, bank, user])).rows[0].id;
    await pool.query("insert into bank_match_lines (group_id, line_id) values ($1, $2)", [group, line]);
    await expect(pool.query("insert into bank_match_lines (group_id, line_id) values ($1, $2)", [group2, line])).rejects.toThrow(/duplicate key/);
    await pool.query("update bank_match_lines set active = false where group_id = $1", [group]);
    await expect(pool.query("update bank_match_lines set active = true where group_id = $1", [group])).rejects.toThrow(/not reopened/);
    await pool.query("insert into bank_match_lines (group_id, line_id) values ($1, $2)", [group2, line]);
    await expect(pool.query("insert into bank_match_groups (id, shop_id, bank_account_id, kind, posting_kind, created_by) values (gen_random_uuid(), $1, $2, 'match', 'bank_charge', $3)", [shop, bank, user])).rejects.toThrow(/check/);
    await pool.query("update bank_match_groups set status = 'undone', undone_by = $2, undone_at = now(), undo_reason = 'wrong' where id = $1", [group, user]);
    await expect(pool.query("update bank_match_groups set status = 'active' where id = $1", [group])).rejects.toThrow(/stays undone/);
    await expect(pool.query("update bank_match_groups set kind = 'settlement' where id = $1", [group2])).rejects.toThrow(/only the journal/);

    // Finished reconciliations are history.
    await pool.query("insert into bank_reconciliations (id, shop_id, bank_account_id, statement_date, statement_balance_paise, book_balance_paise, opening_gap_paise, book_not_in_bank_paise, bank_not_in_books_paise, difference_paise, matched_count, outstanding, finalized_by) values (gen_random_uuid(), $1, $2, '2026-10-31', 0, 0, 0, 0, 0, 0, 0, '[]', $3)", [shop, bank, user]);
    await expect(pool.query("update bank_reconciliations set note = 'x'")).rejects.toThrow(/append-only/);
    await expect(pool.query("delete from bank_reconciliations")).rejects.toThrow(/append-only/);
  });
});
