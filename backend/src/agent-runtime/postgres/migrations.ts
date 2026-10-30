import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool, PoolClient } from "pg";

const MIGRATION_LOCK_KEY = "pr-agent:harness:migrations:v1";
const MIGRATION_NAME_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;

interface BaselineManifest {
  schemaVersion: 1;
  through: string;
  sqlFile: string;
  sqlSha256: string;
  migrations: Array<{ name: string; checksum: string }>;
}

export async function migrateRuntime(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Migration timeouts are local to this transaction; runtime queries keep
    // their shorter bounds, and a blocked DDL leaves no partial schema behind.
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '2min'");
    await client.query("SET LOCAL row_security = on");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);
    const namespace = await client.query<{ owned: boolean; external_create: boolean }>(`
      SELECT n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned,
        EXISTS (SELECT 1 FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
          WHERE a.privilege_type='CREATE' AND a.grantee<>n.nspowner) AS external_create
      FROM pg_namespace n WHERE n.nspname='pr_agent_harness'`);
    if (namespace.rowCount) {
      if (!namespace.rows[0]!.owned) throw new Error("Runtime schema must be owned by the migration role");
      if (namespace.rows[0]!.external_create) throw new Error("Runtime schema CREATE privilege must be exclusive to its owner");
    }
    const existing = await client.query<{ ledger: string | null }>(
      "SELECT to_regclass('pr_agent_harness.schema_migrations')::text AS ledger",
    );
    const fresh = existing.rows[0]?.ledger === null;
    if (fresh) {
      // Inspect before creating metadata: every namespace object counts, including
      // collations, operators and types, not just tables/functions we know about.
      const occupied = await client.query<{ occupied: boolean }>(`
        SELECT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_namespace n ON n.oid=d.refobjid
          WHERE d.refclassid='pg_namespace'::regclass AND n.nspname='pr_agent_harness') AS occupied`);
      if (occupied.rows[0]?.occupied) throw new Error("Cannot initialize a nonempty runtime schema without a migration ledger");
    } else {
      const ledger = await client.query("SELECT 1 FROM pr_agent_harness.schema_migrations LIMIT 1");
      if (!ledger.rowCount) throw new Error("Cannot initialize a committed empty migration ledger; inspect its provenance first");
    }
    await client.query("CREATE SCHEMA IF NOT EXISTS pr_agent_harness");
    await client.query(`
      CREATE TABLE IF NOT EXISTS pr_agent_harness.schema_migrations (
        migration_name text PRIMARY KEY,
        checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
        baseline_manifest_hash text,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query("ALTER TABLE pr_agent_harness.schema_migrations ADD COLUMN IF NOT EXISTS baseline_manifest_hash text");
    const migrations = await listMigrations();
    if (fresh) await applyFreshBaseline(client, migrations);

    for (const migrationName of migrations) {
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

async function applyFreshBaseline(client: PoolClient, migrations: string[]): Promise<void> {
  const directory = join(await resolveMigrationDirectory(), "../baseline");
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as BaselineManifest;
  if (manifest.schemaVersion !== 1 || manifest.sqlFile !== "020_schema.sql"
      || manifest.through !== "020_release_control.sql" || !Array.isArray(manifest.migrations)
      || manifest.migrations.length !== 20) throw new Error("Invalid runtime baseline manifest");
  const covered = migrations.filter((name) => name <= manifest.through);
  if (JSON.stringify(covered) !== JSON.stringify(manifest.migrations.map((entry) => entry.name))) {
    throw new Error("Runtime baseline migration coverage mismatch");
  }
  for (const entry of manifest.migrations) {
    if (sha256(await readMigration(entry.name)) !== entry.checksum) {
      throw new Error(`Runtime baseline checksum mismatch: ${entry.name}`);
    }
  }
  const sql = await readFile(join(directory, manifest.sqlFile), "utf8");
  if (sha256(sql) !== manifest.sqlSha256) throw new Error("Runtime baseline SQL checksum mismatch");
  const manifestHash = sha256(JSON.stringify({ schemaVersion: manifest.schemaVersion,
    through: manifest.through, sqlFile: manifest.sqlFile, sqlSha256: manifest.sqlSha256,
    migrations: manifest.migrations.map(({ name, checksum }) => ({ name, checksum })) }));
  await client.query(sql);
  for (const entry of manifest.migrations) {
    await client.query(`INSERT INTO pr_agent_harness.schema_migrations
      (migration_name,checksum_sha256,baseline_manifest_hash) VALUES ($1,$2,$3)`,
    [entry.name, entry.checksum, manifestHash]);
  }
}

function sha256(text: string): string { return createHash("sha256").update(text).digest("hex"); }

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
    new URL("../../../src/agent-runtime/postgres/migrations/", import.meta.url),
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
    "unable to find harness migrations; copy them into dist/agent-runtime/postgres/migrations during build",
    { cause: firstError },
  );
}
