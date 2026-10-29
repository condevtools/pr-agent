import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

if (process.argv.length !== 2) throw new Error("backup drill does not accept database URLs or arguments");

const container = `pr-agent-backup-drill-${randomUUID().slice(0, 12)}`;
const password = randomUUID();
const sourceDatabase = `harness_drill_source_${randomUUID().replaceAll("-", "")}`;
const restoredDatabase = `harness_drill_restored_${randomUUID().replaceAll("-", "")}`;
const tenantId = randomUUID();
const otherTenantId = randomUUID();
const integrationId = randomUUID();
const otherIntegrationId = randomUUID();
const runId = randomUUID();
const otherRunId = randomUUID();
const stepId = randomUUID();
const attemptId = randomUUID();
let created = false;

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", timeout: 120_000, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} ${args[0] ?? ""} failed: ${result.error?.message ?? result.stderr ?? "nonzero exit"}`);
  }
  return result.stdout.trim();
}

function docker(args, options = {}) {
  return command("docker", args, options);
}

function psql(database, sql) {
  return docker(["exec", "-i", container, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database, "-At"], {
    input: sql,
  });
}

function databaseUrl(port, database) {
  const url = new URL(`postgresql://postgres@127.0.0.1:${port}/${database}`);
  url.password = password;
  return url.toString();
}

function migrate(url) {
  const code = `
    import { Pool } from "pg";
    import { migrateRuntime } from "./src/agent-runtime/postgres/migrations.ts";
    const pool = new Pool({ connectionString: process.env.DRILL_DATABASE_URL });
    try { await migrateRuntime(pool); } finally { await pool.end(); }
  `;
  command(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, DRILL_DATABASE_URL: url },
  });
}

try {
  docker(["info", "--format", "{{.ServerVersion}}"]);
  docker([
    "run", "--detach", "--name", container, "--label", "pr-agent.backup-drill=true",
    "--env", "POSTGRES_PASSWORD", "--publish", "127.0.0.1::5432", "postgres:17-alpine",
  ], { env: { ...process.env, POSTGRES_PASSWORD: password } });
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], {
      stdio: "ignore", timeout: 5_000,
    });
    if (probe.status === 0) { ready = true; break; }
    await delay(500);
  }
  if (!ready) throw new Error("backup drill PostgreSQL did not become ready");
  const server = docker(["exec", container, "postgres", "--version"]);
  if (!/PostgreSQL\) 17\./.test(server)) throw new Error(`backup drill requires PostgreSQL 17, found ${server}`);
  const port = docker(["port", container, "5432/tcp"]).split(":").at(-1);
  if (!port || !/^\d+$/.test(port)) throw new Error("backup drill could not resolve its isolated port");
  docker(["exec", container, "createdb", "-U", "postgres", sourceDatabase]);
  migrate(databaseUrl(port, sourceDatabase));

  const h = "a".repeat(64);
  psql(sourceDatabase, `
    INSERT INTO pr_agent_harness.integration_bindings(id,tenant_id,platform,origin,repository)
      VALUES ('${integrationId}','${tenantId}','github','https://github.example.test','drill/source'),
             ('${otherIntegrationId}','${otherTenantId}','github','https://github.example.test','drill/other');
    INSERT INTO pr_agent_harness.agent_runs
      (id,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,
       request_hash,run_type,base_sha,head_sha,workflow_version_hash,prompt_version_hash,
       model_version_hash,tool_version_hash,policy_version_hash,runtime_version_hash,input_json,
       status,lease_epoch,finished_at,next_event_seq,event_retention_floor)
      VALUES
      ('${runId}','${tenantId}','${integrationId}','system','backup-drill','drill','source','${h}',
       'review.single.v1','base','head','${h}','${h}','${h}','${h}','${h}','${h}',
       '{"fixture":"source"}','succeeded',1,now(),3,1),
      ('${otherRunId}','${otherTenantId}','${otherIntegrationId}','system','backup-drill','drill','other','${h}',
       'review.single.v1','base','head','${h}','${h}','${h}','${h}','${h}','${h}',
       '{"fixture":"other"}','succeeded',1,now(),2,1);
    INSERT INTO pr_agent_harness.run_events
      (tenant_id,run_id,sequence,event_type,visibility,actor_type,actor_id,payload_json)
      VALUES ('${tenantId}','${runId}',1,'run.created','public','system','backup-drill','{}'),
             ('${tenantId}','${runId}',2,'run.succeeded','public','system','backup-drill','{}'),
             ('${otherTenantId}','${otherRunId}',1,'run.created','public','system','backup-drill','{}');
    INSERT INTO pr_agent_harness.agent_steps
      (id,tenant_id,run_id,step_key,step_kind,input_hash,status,output_hash,output_json,last_lease_epoch,
       attempt_count,completed_at)
      VALUES ('${stepId}','${tenantId}','${runId}','drill','model','${h}','succeeded','${h}',
              '{"checkpoint":"source"}',1,1,now());
    INSERT INTO pr_agent_harness.step_attempts
      (id,tenant_id,run_id,step_id,attempt_number,lease_owner,lease_epoch,status,completed_at)
      VALUES ('${attemptId}','${tenantId}','${runId}','${stepId}',1,'backup-drill',1,'succeeded',now());
    INSERT INTO pr_agent_harness.checkpoints
      (tenant_id,run_id,sequence,step_id,step_attempt_id,schema_version,runtime_version_hash,
       state_hash,state_json,lease_epoch)
      VALUES ('${tenantId}','${runId}',1,'${stepId}','${attemptId}',1,'${h}','${h}',
              '{"checkpoint":"durable"}',1);
  `);
  const invariantSql = `
    SELECT encode(digest(concat_ws('|',r.request_hash,r.next_event_seq,r.event_retention_floor,
      (SELECT count(*) FROM pr_agent_harness.run_events e WHERE e.tenant_id=r.tenant_id AND e.run_id=r.id),
      (SELECT state_hash FROM pr_agent_harness.checkpoints c WHERE c.tenant_id=r.tenant_id AND c.run_id=r.id)),
      'sha256'),'hex')
    FROM pr_agent_harness.agent_runs r WHERE r.tenant_id='${tenantId}' AND r.id='${runId}';
  `;
  const beforeHash = psql(sourceDatabase, invariantSql);
  docker(["exec", container, "pg_dump", "-U", "postgres", "--format=custom", "--no-owner", "--no-acl",
    "--file=/tmp/harness-drill.dump", sourceDatabase]);
  const archiveList = docker(["exec", container, "pg_restore", "--list", "/tmp/harness-drill.dump"]);
  if (!archiveList.includes("TABLE pr_agent_harness agent_runs")
      || !archiveList.includes("TABLE pr_agent_harness checkpoints")) {
    throw new Error("backup archive listing is missing critical Harness tables");
  }
  docker(["exec", container, "createdb", "-U", "postgres", restoredDatabase]);
  docker(["exec", container, "pg_restore", "-U", "postgres", "--dbname", restoredDatabase,
    "--single-transaction", "--exit-on-error", "--no-owner", "--no-acl", "/tmp/harness-drill.dump"]);
  migrate(databaseUrl(port, restoredDatabase));
  migrate(databaseUrl(port, restoredDatabase));
  const afterHash = psql(restoredDatabase, invariantSql);
  if (!beforeHash || beforeHash !== afterHash) throw new Error("restored critical-record hash does not match source");
  const cursorCheckpoint = psql(restoredDatabase, `
    SELECT r.event_retention_floor||':'||r.next_event_seq||':'||c.sequence||':'||c.state_hash
    FROM pr_agent_harness.agent_runs r JOIN pr_agent_harness.checkpoints c
      ON c.tenant_id=r.tenant_id AND c.run_id=r.id
    WHERE r.tenant_id='${tenantId}' AND r.id='${runId}';
  `);
  if (cursorCheckpoint !== `1:3:1:${h}`) throw new Error("cursor or checkpoint continuity changed after restore");
  const rls = psql(restoredDatabase, `
    CREATE ROLE drill_reader NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA pr_agent_harness TO drill_reader;
    GRANT SELECT ON pr_agent_harness.agent_runs,pr_agent_harness.run_events,
      pr_agent_harness.checkpoints TO drill_reader;
    SET ROLE drill_reader;
    SELECT set_config('app.tenant_id','${tenantId}',false);
    SELECT count(*) FROM pr_agent_harness.agent_runs;
    SELECT set_config('app.tenant_id','${otherTenantId}',false);
    SELECT count(*) FROM pr_agent_harness.agent_runs WHERE id='${runId}';
    RESET ROLE;
  `).split("\n").filter((line) => /^\d+$/.test(line));
  if (rls.at(-2) !== "1" || rls.at(-1) !== "0") throw new Error("restored limited-role RLS verification failed");
  const migrationCount = psql(restoredDatabase, "SELECT count(*) FROM pr_agent_harness.schema_migrations;");
  if (!/^\d+$/.test(migrationCount) || Number(migrationCount) < 15) throw new Error("restored migrations are incomplete");
  console.log(`Harness isolated backup drill passed on ${server}: archive list, hash, cursor, checkpoint, migrations, and RLS verified.`);
} finally {
  if (created) {
    try { docker(["rm", "--force", "--volumes", container]); }
    catch { process.exitCode = 1; }
  }
}
