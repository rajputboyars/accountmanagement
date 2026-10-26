import { randomBytes } from "node:crypto";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, inject } from "vitest";
import { closeDb } from "@/server/db";
import * as schema from "@/server/schema";

export type TestDatabase = {
  name: string;
  /** Connects as the schema owner: for test setup and assertions that bypass app privileges. */
  owner: NodePgDatabase<typeof schema>;
  ownerPool: Pool;
};

/**
 * Gives the calling test file its own database cloned from the migrated template, and points the
 * app (DATABASE_URL) at it as the restricted nexora_app role. Dropped after the file finishes.
 */
export function setupTestDatabase(): TestDatabase {
  const handle = {} as TestDatabase;
  const pg = inject("pg");
  const url = (user: string, password: string, db: string) => `postgres://${user}:${password}@${pg.host}:${pg.port}/${db}`;

  beforeAll(async () => {
    handle.name = `t_${randomBytes(6).toString("hex")}`;
    const admin = new Pool({ connectionString: url("nexora_owner", pg.ownerPassword, "postgres"), max: 1 });
    await admin.query(`CREATE DATABASE ${handle.name} TEMPLATE nexora_template`);
    await admin.end();

    process.env.DATABASE_URL = url("nexora_app", pg.appPassword, handle.name);
    process.env.DATABASE_POOL_MAX = "10";
    handle.ownerPool = new Pool({ connectionString: url("nexora_owner", pg.ownerPassword, handle.name), max: 4 });
    handle.owner = drizzle(handle.ownerPool, { schema });
  });

  afterAll(async () => {
    await closeDb();
    await handle.ownerPool?.end();
    const admin = new Pool({ connectionString: url("nexora_owner", pg.ownerPassword, "postgres"), max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${handle.name} WITH (FORCE)`);
    await admin.end();
  });

  return handle;
}
