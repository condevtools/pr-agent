import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";

const url = process.env.HARNESS_TEST_DATABASE_URL;
if (!url) {
  test.skip("Migration baseline requires dedicated Docker PostgreSQL", () => {});
} else {
  if (!new URL(url).pathname.startsWith("/harness_test_")) throw new Error("Disposable database required");
  test("fresh baseline and historical upgrade produce identical schema, ACL, RLS, functions and indexes", async () => {
    const pool = new Pool({ connectionString: url });
    try {
      await migrateRuntime(pool);
      const fresh = await catalog(pool);
      const ledger = await pool.query("SELECT * FROM pr_agent_harness.schema_migrations ORDER BY migration_name");
      assert.equal(ledger.rows.filter((r) => r.baseline_manifest_hash).length, 20);
      assert.equal(new Set(ledger.rows.slice(0, 20).map((r) => r.baseline_manifest_hash)).size, 1);
      await migrateRuntime(pool);
      assert.deepEqual(await catalog(pool), fresh);
      await pool.query("DROP SCHEMA pr_agent_harness CASCADE");
      await pool.query(`CREATE SCHEMA pr_agent_harness; CREATE TABLE pr_agent_harness.schema_migrations (
        migration_name text PRIMARY KEY,checksum_sha256 text NOT NULL CHECK(checksum_sha256 ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now())`);
      const directory = new URL("../../src/agent-runtime/postgres/migrations/", import.meta.url);
      for (const name of (await readdir(directory)).filter((n) => /^0(0[1-9]|1[0-9]|20)_/.test(n)).sort()) {
        const sql = await readFile(new URL(name, directory), "utf8");
        await pool.query(sql);
        await pool.query("INSERT INTO pr_agent_harness.schema_migrations(migration_name,checksum_sha256) VALUES($1,$2)",
          [name, createHash("sha256").update(sql).digest("hex")]);
      }
      await migrateRuntime(pool);
      assert.deepEqual(await catalog(pool), fresh);
      const covered = await pool.query("SELECT count(*)::int AS n FROM pr_agent_harness.schema_migrations WHERE baseline_manifest_hash IS NOT NULL");
      assert.equal(covered.rows[0].n, 0, "Upgrade must not claim it used the fresh baseline");
      await pool.query("UPDATE pr_agent_harness.schema_migrations SET checksum_sha256=repeat('0',64) WHERE migration_name='001_harness_core.sql'");
      await assert.rejects(migrateRuntime(pool), /checksum mismatch/);
    } finally { await pool.end(); }
  });
  test("empty ledger with partial objects is rejected atomically", async () => {
    const pool = new Pool({ connectionString: url });
    try {
      await pool.query("DROP SCHEMA IF EXISTS pr_agent_harness CASCADE; CREATE SCHEMA pr_agent_harness; CREATE TABLE pr_agent_harness.partial(id int)");
      await assert.rejects(migrateRuntime(pool), /nonempty runtime schema/);
      assert.equal((await pool.query("SELECT to_regclass('pr_agent_harness.schema_migrations') AS ledger")).rows[0].ledger, null);
      assert.ok((await pool.query("SELECT to_regclass('pr_agent_harness.partial') AS existing")).rows[0].existing);
    } finally { await pool.end(); }
  });
  test("baseline DDL failure rolls back schema and covered ledger together", async () => {
    const pool = new Pool({ connectionString: url });
    try {
      await pool.query(`DROP SCHEMA IF EXISTS pr_agent_harness CASCADE;
        CREATE FUNCTION public.reject_baseline_fixture() RETURNS event_trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF to_regclass('pr_agent_harness.agent_runs') IS NOT NULL THEN
            RAISE EXCEPTION 'injected baseline failure';
          END IF;
        END; $$;
        CREATE EVENT TRIGGER reject_baseline_fixture ON ddl_command_end WHEN TAG IN ('CREATE TABLE')
          EXECUTE FUNCTION public.reject_baseline_fixture()`);
      await assert.rejects(migrateRuntime(pool), /injected baseline failure/);
      assert.equal((await pool.query("SELECT to_regnamespace('pr_agent_harness') AS schema")).rows[0].schema, null);
    } finally {
      await pool.query("DROP EVENT TRIGGER IF EXISTS reject_baseline_fixture; DROP FUNCTION IF EXISTS public.reject_baseline_fixture()");
      await pool.end();
    }
  });
  test("initialization rejects any preexisting namespace object and a committed empty ledger", async () => {
    const pool = new Pool({ connectionString: url });
    try {
      await pool.query(`DROP SCHEMA IF EXISTS pr_agent_harness CASCADE; CREATE SCHEMA pr_agent_harness;
        CREATE COLLATION pr_agent_harness.foreign_collation FROM "C"`);
      await assert.rejects(migrateRuntime(pool), /nonempty runtime schema/);
      assert.equal((await pool.query("SELECT to_regclass('pr_agent_harness.schema_migrations') AS ledger")).rows[0].ledger, null);
      await pool.query(`DROP SCHEMA pr_agent_harness CASCADE; CREATE SCHEMA pr_agent_harness;
        CREATE TABLE pr_agent_harness.schema_migrations (migration_name text PRIMARY KEY,
          checksum_sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);
      await assert.rejects(migrateRuntime(pool), /committed empty migration ledger/);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM pr_agent_harness.schema_migrations")).rows[0].n, 0);
    } finally { await pool.end(); }
  });
  test("migration rejects a foreign schema owner and external CREATE grants before any DDL", async () => {
    const pool = new Pool({ connectionString: url });
    const role = `foreign_schema_${randomUUID().replaceAll("-", "")}`;
    try {
      await pool.query(`DROP SCHEMA IF EXISTS pr_agent_harness CASCADE; CREATE ROLE ${role} NOLOGIN;
        CREATE SCHEMA pr_agent_harness AUTHORIZATION ${role}`);
      await assert.rejects(migrateRuntime(pool), /schema must be owned by the migration role/);
      assert.equal((await pool.query("SELECT to_regclass('pr_agent_harness.schema_migrations') AS ledger")).rows[0].ledger, null);
      await pool.query(`DROP SCHEMA pr_agent_harness; CREATE SCHEMA pr_agent_harness;
        GRANT CREATE ON SCHEMA pr_agent_harness TO ${role}`);
      await assert.rejects(migrateRuntime(pool), /schema CREATE privilege must be exclusive/);
      assert.equal((await pool.query("SELECT to_regclass('pr_agent_harness.schema_migrations') AS ledger")).rows[0].ledger, null);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS pr_agent_harness CASCADE; DROP ROLE IF EXISTS ${role}`);
      await pool.end();
    }
  });
}

async function catalog(pool: Pool): Promise<unknown> {
  const queries = {
    relations: `SELECT c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relacl,c.reloptions,
      obj_description(c.oid,'pg_class') AS comment FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='pr_agent_harness' AND c.relname NOT LIKE 'schema_migrations%' ORDER BY c.relname`,
    columns: `SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,
      pg_get_expr(d.adbin,d.adrelid) AS default_value,a.attacl FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname='pr_agent_harness' AND c.relkind IN ('r','v') AND c.relname<>'schema_migrations' AND a.attnum>0
      AND NOT a.attisdropped ORDER BY c.relname,a.attname`,
    constraints: `SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='pr_agent_harness' AND c.relname<>'schema_migrations' ORDER BY c.relname,k.conname`,
    indexes: `SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='pr_agent_harness'
      AND tablename<>'schema_migrations' ORDER BY indexname`,
    policies: `SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies
      WHERE schemaname='pr_agent_harness' ORDER BY tablename,policyname`,
    functions: `SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS args,
      pg_get_functiondef(p.oid) AS definition,p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='pr_agent_harness' ORDER BY p.proname,args`,
    triggers: `SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='pr_agent_harness' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
  };
  const result: Record<string, unknown> = {};
  for (const [name, sql] of Object.entries(queries)) result[name] = (await pool.query(sql)).rows;
  return result;
}
