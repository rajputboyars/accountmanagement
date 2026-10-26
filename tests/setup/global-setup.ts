import { randomBytes } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import type { TestProject } from "vitest/node";

export type TestPg = { host: string; port: number; ownerPassword: string; appPassword: string };

declare module "vitest" {
  export interface ProvidedContext {
    pg: TestPg;
  }
}

/**
 * Starts a throwaway PostgreSQL 16 container (credentials random per run, never written to disk),
 * creates the same roles as db/docker/init/01-app-role.sh, and applies the real migrations to a
 * template database that each test file clones. The container is removed after the run.
 */
export default async function setup(project: TestProject) {
  const ownerPassword = randomBytes(18).toString("hex");
  const appPassword = randomBytes(18).toString("hex");

  let container: StartedPostgreSqlContainer;
  try {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("nexora_template")
      .withUsername("nexora_owner")
      .withPassword(ownerPassword)
      .start();
  } catch (error) {
    throw new Error(
      `Could not start the test PostgreSQL container. Is Docker Desktop running?\n${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const host = container.getHost();
  const port = container.getPort();
  const pool = new Pool({ connectionString: `postgres://nexora_owner:${ownerPassword}@${host}:${port}/nexora_template`, max: 1 });
  try {
    await pool.query(`CREATE ROLE nexora_app LOGIN PASSWORD '${appPassword}'`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO nexora_app`);
    await pool.query(`ALTER DEFAULT PRIVILEGES FOR ROLE nexora_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nexora_app`);
    await pool.query(`ALTER DEFAULT PRIVILEGES FOR ROLE nexora_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO nexora_app`);
    await migrate(drizzle(pool), { migrationsFolder: "db/migrations" });
  } finally {
    await pool.end();
  }

  project.provide("pg", { host, port, ownerPassword, appPassword });

  return async () => {
    await container.stop();
  };
}
