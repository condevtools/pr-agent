import { Pool } from "pg";
import { readFile } from "node:fs/promises";

import { RuntimeDatabase } from "./postgres/database.js";
import { migrateRuntime } from "./postgres/migrations.js";
import { RunStore } from "./postgres/run-store.js";
import { agentRuntimePoolConfig, resolveAgentProcessRole } from "./runtime/config.js";
import { checkRuntimeReadiness } from "./runtime/readiness.js";
import { PublicationAuthorityStore } from "./authority/publication-authority.js";
import { PublicationControlStore, type PublicationControlInput } from "./publication/control.js";
import { RuntimeMetricsStore } from "./metrics.js";
import { PgEvolutionDatasetMaintenanceStore } from "../evolution/datasets/maintenance.js";
import { logCore, validateRuntimeEnvironment } from "#core";

const [command, ...args] = process.argv.slice(2);
const profile = command === "migrate" ? "migrate" : "admin";
validateRuntimeEnvironment(process.env, profile);
const pool = new Pool(agentRuntimePoolConfig(process.env, "web", profile));
const db = new RuntimeDatabase(pool);
const authority = new PublicationAuthorityStore(db);
try {
  if (command === "ready") {
    const fields = parseFields(args, ["--role"]);
    const role = resolveAgentProcessRole({ ...process.env, PR_AGENT_PROCESS_ROLE: fields.get("--role") });
    const status = await checkRuntimeReadiness({ pool, role });
    console.log(JSON.stringify(status));
    if (!status.ok) process.exitCode = 1;
  } else if (command === "migrate" && args.length === 0) {
    const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
    if (!role.rows[0] || role.rows[0].rolsuper || role.rows[0].rolbypassrls) {
      throw new Error("Database initialization requires a dedicated NOSUPERUSER NOBYPASSRLS schema owner");
    }
    for (const name of ["pr_agent_app", "pr_agent_verifier", "pr_agent_maintenance"]) {
      const exists = await pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [name]);
      if (!exists.rowCount) throw new Error(`Bootstrap PostgreSQL role ${name} before database initialization`);
    }
    await migrateRuntime(pool);
    console.log("Database schema initialized; versioned migrations and role grants applied");
  } else if (command === "bind") {
    const fields = parseFields(args, ["--tenant", "--id", "--platform", "--origin", "--repository"]);
    const platform = fields.get("--platform");
    if (platform !== "github" && platform !== "gitlab") throw new Error("platform must be github or gitlab");
    await new RunStore(db).registerIntegration({
      tenantId: fields.get("--tenant")!, id: fields.get("--id")!, platform,
      origin: fields.get("--origin")!, repository: fields.get("--repository")!,
    });
    console.log("Trusted integration binding registered; publication remains blocked until configured and activated");
  } else if (command === "configure") {
    const fields = parseFields(args, ["--tenant", "--id", "--repository-id", "--actor-id", "--credential-ref", "--version"]);
    await authority.configure({ tenantId: fields.get("--tenant")!, integrationId: fields.get("--id")!,
      providerRepositoryId: Number(fields.get("--repository-id")), providerActorId: Number(fields.get("--actor-id")),
      credentialRef: fields.get("--credential-ref")!, expectedVersion: Number(fields.get("--version")) });
    console.log(JSON.stringify(await authority.get(fields.get("--tenant")!, fields.get("--id")!)));
  } else if (command === "authority") {
    const fields = parseFields(args, ["--tenant", "--id", "--action", "--version"], ["--evidence"]);
    const action = fields.get("--action");
    if (action !== "activate" && action !== "drain" && action !== "block") throw new Error("Authority action must be activate, drain or block");
    console.log(JSON.stringify(await authority.transition({ tenantId: fields.get("--tenant")!, integrationId: fields.get("--id")!,
      action, expectedVersion: Number(fields.get("--version")), actor: await administrativeActor(), actorType: "service",
      quiescenceEvidence: fields.get("--evidence") })));
  } else if (command === "capabilities") {
    const fields = parseFields(args, ["--tenant", "--id", "--version", "--deep", "--fix",
      "--evolution", "--default-review"], ["--issue-triage"]);
    const defaultReview = fields.get("--default-review");
    if (defaultReview !== "single" && defaultReview !== "deep") {
      throw new Error("--default-review must be single or deep");
    }
    console.log(JSON.stringify(await authority.configureCapabilities({
      tenantId: fields.get("--tenant")!, integrationId: fields.get("--id")!,
      expectedVersion: Number(fields.get("--version")),
      reviewDeep: onOff(fields.get("--deep")!, "--deep"),
      ...(fields.has("--issue-triage") ? { issueTriage: onOff(fields.get("--issue-triage")!, "--issue-triage") } : {}),
      fix: onOff(fields.get("--fix")!, "--fix"),
      evolution: onOff(fields.get("--evolution")!, "--evolution"),
      defaultReviewWorkflow: defaultReview === "deep" ? "review.deep.v1" : "review.single.v1",
      actor: await administrativeActor(), actorType: "service",
    })));
  } else if (command === "execution-drain") {
    const fields = parseFields(args, ["--tenant", "--id", "--version", "--evidence"]);
    console.log(JSON.stringify(await authority.drainExecution({
      tenantId: fields.get("--tenant")!, integrationId: fields.get("--id")!,
      expectedVersion: Number(fields.get("--version")), evidence: fields.get("--evidence")!,
      actor: await administrativeActor(), actorType: "service",
    })));
  } else if (command === "execution-resume") {
    const fields = parseFields(args, ["--tenant", "--id", "--version", "--evidence"]);
    console.log(JSON.stringify(await authority.resumeExecution({
      tenantId: fields.get("--tenant")!, integrationId: fields.get("--id")!,
      expectedVersion: Number(fields.get("--version")), evidence: fields.get("--evidence")!,
      actor: await administrativeActor(), actorType: "service",
    })));
  } else if (command === "dataset-retire") {
    const fields = parseFields(args, ["--tenant", "--dataset", "--version"]);
    console.log(JSON.stringify(await new PgEvolutionDatasetMaintenanceStore(pool).retire({
      tenantId: fields.get("--tenant")!, datasetId: fields.get("--dataset")!, expectedVersion: Number(fields.get("--version")) })));
  } else if (command === "dataset-purge") {
    const fields = parseFields(args, ["--tenant", "--dataset"]);
    console.log(JSON.stringify(await new PgEvolutionDatasetMaintenanceStore(pool).purge({
      tenantId: fields.get("--tenant")!, datasetId: fields.get("--dataset")! })));
  } else if (command === "metrics") {
    const fields = parseFields(args, ["--tenant", "--id"]);
    console.log(JSON.stringify(await new RuntimeMetricsStore(db).snapshot(fields.get("--tenant")!, fields.get("--id")!)));
  } else if (command === "inspect") {
    const fields = parseFields(args, ["--tenant", "--id"]);
    console.log(JSON.stringify(await authority.get(fields.get("--tenant")!, fields.get("--id")!)));
    const result = await db.transaction(fields.get("--tenant")!, (client) => client.query(
      `SELECT business_operation_id,status,outcome_code,version,last_error_code,remote_id
       FROM pr_agent_harness.repository_operations WHERE tenant_id=$1 AND integration_id=$2
       ORDER BY updated_at DESC LIMIT 100`, [fields.get("--tenant"), fields.get("--id")],
    ));
    console.log(JSON.stringify(result.rows));
  } else if (command === "control") {
    const fields = parseFields(args, ["--input-file"]);
    const input: unknown = JSON.parse(await readFile(fields.get("--input-file")!, "utf8"));
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Control input must be a JSON object");
    const supplied = input as PublicationControlInput;
    // Manual decisions are explicitly administrative attestations, not automatic
    // provider verification. The authenticated DB role owns the audit identity.
    const commandInput = { ...supplied,
      actor: { type: "service" as const, id: await administrativeActor() },
      evidence: { ...supplied.evidence, verification: "administrator_attestation" },
    };
    console.log(JSON.stringify(await new PublicationControlStore(db).apply(commandInput)));
  } else {
    throw new Error("Usage: harness ready | migrate | bind | configure | capabilities | authority | execution-drain | execution-resume | dataset-retire | dataset-purge | metrics | inspect | control (see backend/docs/agent-runtime.md)");
  }
} catch (error) {
  logCore("error", "harness_admin.failed", { error });
  console.error(JSON.stringify({ code: "HARNESS_ADMIN_FAILED",
    errorType: error instanceof Error ? error.name : "UnknownError" }));
  process.exitCode = 1;
} finally {
  await pool.end();
}

function parseFields(values: string[], required: string[], optional: string[] = []): Map<string, string> {
  const allowed = new Set([...required, ...optional]);
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key || !allowed.has(key) || !value || result.has(key)) throw new Error("Invalid or duplicate administrative argument");
    result.set(key, value);
  }
  if (required.some((key) => !result.has(key))) throw new Error(`Required arguments: ${required.join(" ")}`);
  return result;
}

async function administrativeActor(): Promise<string> {
  const identity = await pool.query<{ actor: string }>("SELECT current_user AS actor");
  return `postgres-role:${identity.rows[0]!.actor}`;
}

function onOff(value: string, name: string): boolean {
  if (value === "on") return true;
  if (value === "off") return false;
  throw new Error(`${name} must be on or off`);
}
