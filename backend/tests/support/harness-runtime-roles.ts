import { readFile } from "node:fs/promises";

import { Pool } from "pg";

const runtimeRoles = ["pr_agent_app", "pr_agent_verifier", "pr_agent_maintenance"] as const;

export async function prepareHarnessRuntimeRoles(
  pool: Pool,
  passwords: { app: string; verifier: string },
): Promise<void> {
  for (const role of runtimeRoles) {
    const password = role === "pr_agent_app" ? passwords.app
      : role === "pr_agent_verifier" ? passwords.verifier : "maintenance-test-only";
    const existing = await pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]);
    const ddl = await pool.query<{ sql: string }>(existing.rowCount
      ? "SELECT format('ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',$1::text,$2::text) AS sql"
      : "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',$1::text,$2::text) AS sql",
    [role, password]);
    await pool.query(ddl.rows[0]!.sql);
  }
}

export async function reapplyVersionedRuntimeGrants(pool: Pool): Promise<void> {
  const migration = await readFile(
    new URL("../../src/agent-runtime/postgres/migrations/025_schema_owner.sql", import.meta.url),
    "utf8",
  );
  const grants = migration.match(/DO \$grants\$[\s\S]*?END \$grants\$;/)?.[0];
  if (!grants) throw new Error("025_schema_owner.sql is missing its versioned runtime grants block");
  await pool.query(grants);
}

export function createMaintenanceTestPool(databaseUrl: string): Pool {
  const url = new URL(databaseUrl);
  url.username = "pr_agent_maintenance";
  url.password = "maintenance-test-only";
  return new Pool({ connectionString: url.toString(), max: 2 });
}
