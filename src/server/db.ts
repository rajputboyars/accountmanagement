import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { getDbEnv } from "./env";

/**
 * One connection pool per server process. In development the pool is kept on globalThis so
 * hot reloads don't open a new pool each time. Every connection gets the architecture's
 * timeouts: a lock wait over 3 s or a statement over 10 s fails instead of hanging the counter.
 */
export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

type DbGlobal = { nexoraPool?: Pool; nexoraDb?: Database };
const globalForDb = globalThis as unknown as DbGlobal;

function createPool(): Pool {
  const env = getDbEnv();
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    application_name: "nexora",
    options: "-c lock_timeout=3000 -c statement_timeout=10000 -c idle_in_transaction_session_timeout=30000",
  });
  pool.on("error", (error) => {
    // An idle client lost its connection; the pool replaces it. Log without connection details.
    console.error("[db] idle client error:", error.message);
  });
  return pool;
}

export function getDb(): Database {
  if (!globalForDb.nexoraDb) {
    globalForDb.nexoraPool = createPool();
    globalForDb.nexoraDb = drizzle(globalForDb.nexoraPool, { schema });
  }
  return globalForDb.nexoraDb;
}

/**
 * Runs `work` in one database transaction (READ COMMITTED). Services take the `tx` so several
 * modules can join the same transaction; nothing commits unless `work` resolves.
 */
export function withTransaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
  return getDb().transaction(work);
}

/** For scripts and tests: closes the pool so the process can exit. */
export async function closeDb(): Promise<void> {
  const pool = globalForDb.nexoraPool;
  globalForDb.nexoraPool = undefined;
  globalForDb.nexoraDb = undefined;
  await pool?.end();
}
