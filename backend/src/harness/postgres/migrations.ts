import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool, PoolClient } from "pg";

const MIGRATION_LOCK_KEY = "pr-agent:harness:migrations:v1";
const MIGRATION_NAME_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;

export async function migrateHarness(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);
    await client.query("CREATE SCHEMA IF NOT EXISTS pr_agent_harness");
    await client.query(`
      CREATE TABLE IF NOT EXISTS pr_agent_harness.schema_migrations (
        migration_name text PRIMARY KEY,
        checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const migrationName of await listMigrations()) {
      await applyMigration(client, migrationName);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function listMigrations(): Promise<string[]> {
  const directory = await resolveMigrationDirectory();
  const entries = await readdir(directory);
  const migrations = entries.filter((entry) => MIGRATION_NAME_PATTERN.test(entry)).sort();
  if (migrations.length === 0) {
    throw new Error(`no harness migrations found in ${directory}`);
  }
  return migrations;
}

async function applyMigration(client: PoolClient, migrationName: string): Promise<void> {
  const sql = await readMigration(migrationName);
  const checksum = createHash("sha256").update(sql).digest("hex");
  const existing = await client.query<{ checksum_sha256: string }>(
    "SELECT checksum_sha256 FROM pr_agent_harness.schema_migrations WHERE migration_name = $1",
    [migrationName],
  );
  if (existing.rowCount === 1) {
    if (existing.rows[0]?.checksum_sha256 !== checksum) {
      throw new Error(`harness migration checksum mismatch: ${migrationName}`);
    }
    return;
  }

  await client.query(sql);
  await client.query(
    "INSERT INTO pr_agent_harness.schema_migrations (migration_name, checksum_sha256) VALUES ($1, $2)",
    [migrationName, checksum],
  );
}

async function readMigration(migrationName: string): Promise<string> {
  const directory = await resolveMigrationDirectory();
  return readFile(join(directory, migrationName), "utf8");
}

async function resolveMigrationDirectory(): Promise<string> {
  const candidates = [
    new URL("./migrations/", import.meta.url),
    new URL("../../../src/harness/postgres/migrations/", import.meta.url),
  ];
  let firstError: unknown;
  for (const candidate of candidates) {
    try {
      const directory = fileURLToPath(candidate);
      await readdir(directory);
      return directory;
    } catch (error) {
      firstError ??= error;
    }
  }
  throw new Error(
    "unable to find harness migrations; copy them into dist/harness/postgres/migrations during build",
    { cause: firstError },
  );
}
