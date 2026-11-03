import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, describe, expect, it, inject } from "vitest";
import { USER_GUIDANCE_STATUSES } from "@/modules/identity/schema";

const upgradeDatabaseName = `upgrade_${randomBytes(6).toString("hex")}`;
const upgradeMigrationsFolder = mkdtempSync(join(tmpdir(), "nexora-migrations-"));
let adminPool: Pool | undefined;
let upgradeOwnerPool: Pool | undefined;
let upgradeAppPool: Pool | undefined;

afterAll(async () => {
  await upgradeAppPool?.end();
  await upgradeOwnerPool?.end();
  if (adminPool) {
    await adminPool.query(`DROP DATABASE IF EXISTS "${upgradeDatabaseName}" WITH (FORCE)`);
    await adminPool.end();
  }
  rmSync(upgradeMigrationsFolder, { recursive: true, force: true });
});

function prepareMigrationsThrough23(): string {
  const sourceFolder = "db/migrations";
  const metadataFolder = join(upgradeMigrationsFolder, "meta");
  mkdirSync(metadataFolder, { recursive: true });
  const journal = JSON.parse(readFileSync(join(sourceFolder, "meta", "_journal.json"), "utf8")) as {
    entries: { idx: number; tag: string }[];
    [key: string]: unknown;
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 23);
  for (const entry of journal.entries) {
    copyFileSync(join(sourceFolder, `${entry.tag}.sql`), join(upgradeMigrationsFolder, `${entry.tag}.sql`));
  }
  writeFileSync(join(metadataFolder, "_journal.json"), JSON.stringify(journal));
  return upgradeMigrationsFolder;
}

describe("migration deployment rehearsal", () => {
  it("upgrades a separate database from 0023 and preserves guidance using owner and app roles", async () => {
    const pg = inject("pg");
    const url = (user: string, password: string, database: string) => `postgres://${user}:${password}@${pg.host}:${pg.port}/${database}`;
    adminPool = new Pool({ connectionString: url("nexora_owner", pg.ownerPassword, "postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${upgradeDatabaseName}"`);

    upgradeOwnerPool = new Pool({ connectionString: url("nexora_owner", pg.ownerPassword, upgradeDatabaseName), max: 1 });
    const migrationsThrough23 = prepareMigrationsThrough23();
    await migrate(drizzle(upgradeOwnerPool), { migrationsFolder: migrationsThrough23 });

    const shopId = "00000000-0000-7000-8000-000000000001";
    const userId = "00000000-0000-7000-8000-000000000002";
    await upgradeOwnerPool.query("INSERT INTO shops (id, name, state_code) VALUES ($1, 'Upgrade rehearsal', '08')", [shopId]);
    await upgradeOwnerPool.query(
      "INSERT INTO users (id, shop_id, name, phone, role) VALUES ($1, $2, 'Owner', '9000000301', 'owner')",
      [userId, shopId],
    );
    await upgradeOwnerPool.query(
      `INSERT INTO user_guidance (shop_id, user_id, kind, key, status, step, started_at, completed_at, updated_at)
       VALUES
         ($1, $2, 'task', 'new_customer', 'completed', 4, '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z', '2026-10-01T11:00:00Z'),
         ($1, $2, 'tip', 'billing', 'dismissed', 0, NULL, NULL, '2026-10-02T11:00:00Z')`,
      [shopId, userId],
    );

    await migrate(drizzle(upgradeOwnerPool), { migrationsFolder: "db/migrations" });

    const history = await upgradeOwnerPool.query<{ count: string }>("SELECT count(*) FROM drizzle.__drizzle_migrations");
    expect(history.rows[0]?.count).toBe("25");
    const oldRecords = await upgradeOwnerPool.query<{
      shop_id: string;
      user_id: string;
      kind: string;
      key: string;
      status: string;
      step: number;
      started_at: Date | null;
      completed_at: Date | null;
      updated_at: Date;
      created_at: Date;
    }>("SELECT * FROM user_guidance ORDER BY kind");
    expect(oldRecords.rows).toHaveLength(2);
    const completedTask = oldRecords.rows.find((row) => row.key === "new_customer");
    expect(completedTask).toMatchObject({
      shop_id: shopId,
      user_id: userId,
      kind: "task",
      key: "new_customer",
      status: "completed",
      step: 4,
    });
    expect(completedTask?.started_at?.toISOString()).toBe("2026-10-01T10:00:00.000Z");
    expect(completedTask?.completed_at?.toISOString()).toBe("2026-10-01T11:00:00.000Z");
    expect(completedTask?.updated_at.toISOString()).toBe("2026-10-01T11:00:00.000Z");
    expect(completedTask?.created_at).toBeInstanceOf(Date);
    expect(oldRecords.rows.find((row) => row.key === "billing")).toMatchObject({
      shop_id: shopId,
      user_id: userId,
      kind: "tip",
      status: "dismissed",
      step: 0,
    });
    expect(oldRecords.rows.every((row) => row.created_at instanceof Date)).toBe(true);

    upgradeAppPool = new Pool({ connectionString: url("nexora_app", pg.appPassword, upgradeDatabaseName), max: 1 });
    const existing = await upgradeAppPool.query("SELECT shop_id, user_id, status, step, completed_at, created_at FROM user_guidance WHERE key = 'new_customer'");
    expect(existing.rows[0]).toMatchObject({ shop_id: shopId, user_id: userId, status: "completed", step: 4 });
    expect(existing.rows[0]?.created_at).toBeInstanceOf(Date);

    for (const [index, status] of USER_GUIDANCE_STATUSES.entries()) {
      await upgradeAppPool.query(
        "INSERT INTO user_guidance (shop_id, user_id, kind, key, status) VALUES ($1, $2, 'task', $3, $4)",
        [shopId, userId, `valid_${index}`, status],
      );
    }
    await expect(
      upgradeAppPool.query(
        "INSERT INTO user_guidance (shop_id, user_id, kind, key, status) VALUES ($1, $2, 'task', 'invalid_status', 'unknown')",
        [shopId, userId],
      ),
    ).rejects.toThrow(/user_guidance_status_check/);

    const beforeInsert = await upgradeAppPool.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    await upgradeAppPool.query(
      "INSERT INTO user_guidance (shop_id, user_id, kind, key, status) VALUES ($1, $2, 'task', 'new_task', 'in_progress')",
      [shopId, userId],
    );
    const newRecord = await upgradeAppPool.query<{ created_at: Date; observed_at: Date }>(
      "SELECT created_at, clock_timestamp() AS observed_at FROM user_guidance WHERE user_id = $1 AND kind = 'task' AND key = 'new_task'",
      [userId],
    );
    expect(newRecord.rows[0]?.created_at).toBeInstanceOf(Date);
    expect(newRecord.rows[0]!.created_at.getTime()).toBeGreaterThanOrEqual(beforeInsert.rows[0]!.now.getTime());
    expect(newRecord.rows[0]!.created_at.getTime()).toBeLessThanOrEqual(newRecord.rows[0]!.observed_at.getTime());

    await expect(upgradeAppPool.query("CREATE TABLE app_role_must_not_ddl (id integer)")).rejects.toThrow(/permission denied/);
    await expect(upgradeAppPool.query("UPDATE drizzle.__drizzle_migrations SET hash = hash")).rejects.toThrow(/permission denied/);
  });

  it("applies the full migration chain when the optional app role is absent", async () => {
    const password = randomBytes(18).toString("hex");
    const container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("nexora_no_app_role")
      .withUsername("nexora_owner")
      .withPassword(password)
      .start();
    const pool = new Pool({ connectionString: container.getConnectionUri(), max: 1 });

    try {
      const roles = await pool.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexora_app') AS exists");
      expect(roles.rows[0]?.exists).toBe(false);
      await migrate(drizzle(pool), { migrationsFolder: "db/migrations" });
      const applied = await pool.query<{ count: string }>("SELECT count(*) FROM drizzle.__drizzle_migrations");
      expect(applied.rows[0]?.count).toBe("25");
      const guidance = await pool.query<{ exists: boolean }>(
        "SELECT to_regclass('public.user_guidance') IS NOT NULL AS exists",
      );
      expect(guidance.rows[0]?.exists).toBe(true);
    } finally {
      await pool.end();
      await container.stop();
    }
  });

  it("skips deployment migrations for Preview unless explicitly enabled", () => {
    const result = spawnSync(process.execPath, ["scripts/migrate-on-deploy.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { NODE_ENV: "test", PATH: process.env.PATH, VERCEL_ENV: "preview" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[deploy] Not a production deploy: skipping migrations.");
    expect(result.stdout).not.toContain("Applying migrations");
  });
});
