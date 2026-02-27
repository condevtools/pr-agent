import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Create a postgres.js SQL client and a Drizzle ORM instance.
 *
 * @param databaseUrl - PostgreSQL connection string
 *   (e.g. `postgres://user:pass@host:5432/db`).
 * @param poolOptions - Optional postgres.js pool overrides.
 * @returns `{ sql, db }` — the raw SQL client (for cleanup) and the typed
 *   Drizzle query builder.
 *
 * @example
 * ```ts
 * const { sql, db } = createDbClient(process.env.DATABASE_URL!);
 * const rows = await db.select().from(schema.tenants);
 * // On shutdown:
 * await sql.end();
 * ```
 */
export function createDbClient(
  databaseUrl: string,
  poolOptions?: {
    /** Max number of connections. Default: 10 */
    max?: number;
    /** Idle timeout in seconds. Default: 20 */
    idleTimeout?: number;
    /** Connection timeout in seconds. Default: 30 */
    connectTimeout?: number;
  },
) {
  const sql = postgres(databaseUrl, {
    max: poolOptions?.max ?? 10,
    idle_timeout: poolOptions?.idleTimeout ?? 20,
    connect_timeout: poolOptions?.connectTimeout ?? 30,
  });

  const db = drizzle(sql, { schema });

  return { sql, db };
}

/**
 * Lazy singleton for the default database connection.
 *
 * Reads `DATABASE_URL` from the environment. When the variable is not set,
 * returns `null` so that callers can fall back to the env-var-only behaviour
 * used before the multi-tenant database was introduced.
 */
let _defaultClient: { sql: postgres.Sql; db: DrizzleDb } | null | undefined;

export function getDefaultDb(): DrizzleDb | null {
  if (_defaultClient === undefined) {
    const url = process.env["DATABASE_URL"];
    if (!url) {
      _defaultClient = null;
    } else {
      _defaultClient = createDbClient(url);
    }
  }
  return _defaultClient?.db ?? null;
}

/**
 * Gracefully close the default database connection pool (e.g. during shutdown).
 */
export async function closeDefaultDb(): Promise<void> {
  if (_defaultClient) {
    await _defaultClient.sql.end();
    _defaultClient = undefined;
  }
}
