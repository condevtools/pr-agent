import { Pool } from "pg";
import { readFile } from "node:fs/promises";

import { HarnessDatabase } from "./postgres/database.js";
import { migrateHarness } from "./postgres/migrations.js";
import { HarnessRunStore } from "./postgres/run-store.js";
import { harnessPoolConfig } from "./runtime.js";
import { PublicationAuthorityStore } from "./authority.js";
import { PublicationControlStore, type PublicationControlInput } from "./publication-control.js";

const [command, ...args] = process.argv.slice(2);
const pool = new Pool(harnessPoolConfig());
const db = new HarnessDatabase(pool);
const authority = new PublicationAuthorityStore(db);
try {
  if (command === "migrate" && args.length === 0) {
    await migrateHarness(pool);
    // The Compose init script creates this least-privilege runtime role.
    const exists = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = 'pr_agent_app'");
    if (!exists.rowCount) {
      throw new Error("Harness runtime role pr_agent_app is missing; initialize it before running migrations");
    }
    await pool.query(`
        GRANT USAGE ON SCHEMA pr_agent_harness TO pr_agent_app;
        GRANT SELECT ON pr_agent_harness.integration_bindings TO pr_agent_app;
        GRANT SELECT, INSERT, UPDATE ON pr_agent_harness.agent_runs,
          pr_agent_harness.job_queue, pr_agent_harness.repository_operations,
          pr_agent_harness.publication_slots, pr_agent_harness.publication_batches TO pr_agent_app;
        GRANT SELECT, INSERT ON pr_agent_harness.publication_batch_operations TO pr_agent_app;
        REVOKE UPDATE, DELETE ON pr_agent_harness.publication_batch_operations FROM pr_agent_app;
        GRANT SELECT, INSERT ON pr_agent_harness.run_events,
          pr_agent_harness.audit_logs TO pr_agent_app;
        GRANT SELECT ON pr_agent_harness.publication_command_receipts TO pr_agent_app;
        GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_publication_authority(
          uuid, uuid, text, text, text, bigint) TO pr_agent_app;
        GRANT EXECUTE ON FUNCTION pr_agent_harness.skip_failed_batch_successors(uuid, uuid) TO pr_agent_app;
    `);
    console.log("Harness migrations applied and runtime grants configured");
  } else if (command === "bind") {
    const fields = parseFields(args, ["--tenant", "--id", "--platform", "--origin", "--repository"]);
    const platform = fields.get("--platform");
    if (platform !== "github" && platform !== "gitlab") throw new Error("platform must be github or gitlab");
    await new HarnessRunStore(db).registerIntegration({
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
    throw new Error("Usage: harness migrate | bind | configure | authority | inspect | control (see backend/HARNESS.md)");
  }
} catch (error) {
  // Do not dump the Pool/driver error object, which can contain connection credentials.
  console.error(error instanceof Error ? error.message : "Harness administration failed");
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
