import { Pool } from "pg";
import { readFile } from "node:fs/promises";

import { HarnessDatabase } from "./postgres/database.js";
import { migrateHarness } from "./postgres/migrations.js";
import { HarnessRunStore } from "./postgres/run-store.js";
import { harnessPoolConfig } from "./runtime.js";
import { PublicationAuthorityStore } from "./authority.js";
import { PublicationControlStore, type PublicationControlInput } from "./publication-control.js";
import { HarnessMaintenanceStore } from "./maintenance.js";
import { HarnessMetricsStore } from "./metrics.js";
import { collectFixSnapshots } from "../fix/snapshot-gc.js";
import { EvolutionDatasetMaintenanceStore } from "../evolution/dataset-maintenance.js";

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
        GRANT SELECT, INSERT ON pr_agent_harness.publication_command_receipts TO pr_agent_app;
        GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_publication_authority(
          uuid, uuid, text, text, text, bigint) TO pr_agent_app;
        GRANT EXECUTE ON FUNCTION pr_agent_harness.skip_failed_batch_successors(uuid, uuid) TO pr_agent_app;
        GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_active_review_execution_authority(uuid,uuid,bigint,bigint),
          pr_agent_harness.lock_resumable_review_execution_authority(uuid,uuid,bigint,bigint),
          pr_agent_harness.lock_active_legacy_review_execution_authority(uuid,uuid,bigint,bigint),
          pr_agent_harness.lock_resumable_legacy_review_execution_authority(uuid,uuid,bigint,bigint) TO pr_agent_app;
        GRANT SELECT, INSERT, UPDATE ON pr_agent_harness.agent_steps,
          pr_agent_harness.step_attempts, pr_agent_harness.tool_calls,
          pr_agent_harness.model_calls, pr_agent_harness.tenant_budget_accounts,
          pr_agent_harness.run_budget_envelopes, pr_agent_harness.model_budget_reservations TO pr_agent_app;
        GRANT SELECT, INSERT ON pr_agent_harness.checkpoints,
          pr_agent_harness.run_publication_batches, pr_agent_harness.dead_letter_jobs,
          pr_agent_harness.usage_records, pr_agent_harness.model_pricing_snapshots TO pr_agent_app;
        GRANT SELECT, INSERT, UPDATE ON pr_agent_harness.run_command_receipts,
          pr_agent_harness.run_waits TO pr_agent_app;
        GRANT SELECT, INSERT ON pr_agent_harness.run_wait_decisions TO pr_agent_app;
        GRANT SELECT, INSERT ON pr_agent_harness.evidence_records,
          pr_agent_harness.finding_candidates, pr_agent_harness.finding_decisions,
          pr_agent_harness.review_artifacts TO pr_agent_app;
        REVOKE UPDATE, DELETE ON pr_agent_harness.evidence_records,
          pr_agent_harness.finding_candidates, pr_agent_harness.finding_decisions,
          pr_agent_harness.review_artifacts FROM pr_agent_app;
        GRANT SELECT, INSERT ON pr_agent_harness.fix_run_sources,
          pr_agent_harness.fix_run_findings, pr_agent_harness.fix_proposals,
          pr_agent_harness.fix_verifications, pr_agent_harness.fix_artifacts,
          pr_agent_harness.fix_relevance_attestations,
          pr_agent_harness.fix_approval_decisions, pr_agent_harness.fix_approval_consumptions,
          pr_agent_harness.verification_jobs TO pr_agent_app;
        GRANT SELECT, INSERT ON pr_agent_harness.fix_approval_requests TO pr_agent_app;
        GRANT UPDATE (status,version,approved_publish_run_id,approved_at,revoked_at,consumed_at)
          ON pr_agent_harness.fix_approval_requests TO pr_agent_app;
        REVOKE UPDATE, DELETE ON pr_agent_harness.fix_run_sources,
          pr_agent_harness.fix_run_findings, pr_agent_harness.fix_proposals,
          pr_agent_harness.fix_verifications, pr_agent_harness.fix_artifacts,
          pr_agent_harness.fix_relevance_attestations,
          pr_agent_harness.fix_approval_decisions, pr_agent_harness.fix_approval_consumptions,
          pr_agent_harness.verification_jobs FROM pr_agent_app;
        GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_resolvable_publication_authority(uuid,uuid,bigint),
          pr_agent_harness.skip_cancelled_run_publications(uuid,uuid) TO pr_agent_app;
        REVOKE INSERT, UPDATE, DELETE ON pr_agent_harness.feedback_observations,
          pr_agent_harness.review_annotations,
          pr_agent_harness.review_annotation_arbitrations,
          pr_agent_harness.trusted_review_label_sets,
          pr_agent_harness.eval_datasets,
          pr_agent_harness.eval_cases,
          pr_agent_harness.eval_fixtures,
          pr_agent_harness.eval_fixture_files FROM pr_agent_app;
        GRANT SELECT ON pr_agent_harness.feedback_observations,
          pr_agent_harness.review_annotations,
          pr_agent_harness.review_annotation_arbitrations,
          pr_agent_harness.trusted_review_label_sets,
          pr_agent_harness.eval_datasets,
          pr_agent_harness.eval_cases,
          pr_agent_harness.eval_fixtures,
          pr_agent_harness.eval_fixture_files TO pr_agent_app;
        GRANT INSERT (tenant_id,integration_id,source_run_id,artifact_hash,command_key,request_hash,actor_type,actor_id,
          observation_json)
          ON pr_agent_harness.feedback_observations TO pr_agent_app;
        GRANT INSERT (id,tenant_id,integration_id,source_run_id,artifact_hash,rubric_version,label_set_hash,label_set_json,
          provenance_json,actor_type,actor_id,command_key,request_hash,supersedes_annotation_id)
          ON pr_agent_harness.review_annotations TO pr_agent_app;
        GRANT INSERT (id,tenant_id,integration_id,source_run_id,artifact_hash,rubric_version,left_annotation_id,
          left_label_set_hash,right_annotation_id,right_label_set_hash,chosen_label_set_hash,actor_type,
          actor_id,command_key,request_hash,reason)
          ON pr_agent_harness.review_annotation_arbitrations TO pr_agent_app;
        GRANT INSERT (id,tenant_id,integration_id,source_run_id,artifact_hash,rubric_version,label_set_hash,label_set_json,
          version,active,supersedes_label_set_id,resolution_kind,resolution_json,arbitration_id)
          ON pr_agent_harness.trusted_review_label_sets TO pr_agent_app;
        GRANT INSERT (tenant_id,name,curator_actor_type,curator_actor_id,split_policy_json,split_policy_hash)
          ON pr_agent_harness.eval_datasets TO pr_agent_app;
        GRANT INSERT (tenant_id,integration_id,dataset_id,source_run_id,fixture_id,label_set_id,source_artifact_hash,
          fixture_hash,label_set_hash,label_set_json,lineage_hash,shingle_hash,shingle_hashes_json,
          source_created_at,repository,pull_number)
          ON pr_agent_harness.eval_cases TO pr_agent_app;
        GRANT INSERT (id,tenant_id,integration_id,run_id,repository,base_sha,head_sha,input_hash,source_step_id,
          source_step_output_hash,artifact_hash,fixture_hash,input_json,files_manifest_json,coverage_json,
          ci_json,total_bytes)
          ON pr_agent_harness.eval_fixtures TO pr_agent_app;
        GRANT INSERT (tenant_id,fixture_id,path,kind,content_text,content_hash,size_bytes) ON pr_agent_harness.eval_fixture_files TO pr_agent_app;
        GRANT UPDATE (superseded_by_annotation_id) ON pr_agent_harness.review_annotations TO pr_agent_app;
        GRANT UPDATE (active) ON pr_agent_harness.trusted_review_label_sets TO pr_agent_app;
        GRANT UPDATE (status,version,manifest_hash,case_count,dev_count,validation_count,holdout_count,frozen_at,updated_at)
          ON pr_agent_harness.eval_datasets TO pr_agent_app;
        GRANT UPDATE (split,ordinal) ON pr_agent_harness.eval_cases TO pr_agent_app;
        REVOKE INSERT, UPDATE, DELETE ON pr_agent_harness.evolution_proposal_sources,
          pr_agent_harness.evolution_candidates,
          pr_agent_harness.eval_runs,
          pr_agent_harness.eval_results FROM pr_agent_app;
        GRANT SELECT ON pr_agent_harness.evolution_proposal_sources,
          pr_agent_harness.evolution_candidates,
          pr_agent_harness.eval_runs,
          pr_agent_harness.eval_results TO pr_agent_app;
        GRANT INSERT (tenant_id,proposal_run_id,dataset_id,dataset_version,dataset_manifest_hash,baseline_prompt_hash,baseline_tool_hash,source_hash,source_json,created_by_actor_type,created_by_actor_id)
          ON pr_agent_harness.evolution_proposal_sources TO pr_agent_app;
        GRANT INSERT (id,tenant_id,proposal_run_id,dataset_id,dataset_version,dataset_manifest_hash,candidate_json,candidate_hash,baseline_prompt_hash,baseline_tool_hash,model_config_hash,source_hash,provenance_json,created_by_actor_type,created_by_actor_id)
          ON pr_agent_harness.evolution_candidates TO pr_agent_app;
        GRANT INSERT (id,tenant_id,dataset_id,candidate_id,curator_actor_type,curator_actor_id,split,command_key,request_hash,repetitions,manifest_hash,baseline_component_hash,candidate_component_hash,model_version_hash,runtime_version_hash,total_result_count,planned_result_count,deadline_at,scheduling_policy_json,scheduling_policy_hash)
          ON pr_agent_harness.eval_runs TO pr_agent_app;
        GRANT INSERT (tenant_id,eval_run_id,dataset_id,case_id,integration_id,variant,repetition,seed_hash,fixture_hash,label_set_id,label_set_hash,component_hash,expected_model_hash,expected_runtime_hash,expected_workflow_hash,expected_prompt_hash,expected_tool_hash,expected_policy_hash,expected_verifier_hash)
          ON pr_agent_harness.eval_results TO pr_agent_app;
        GRANT UPDATE (status,version,completed_result_count,failed_result_count,lease_owner,lease_epoch,
          lease_expires_at,heartbeat_at,available_at,error_code,metrics_json,metrics_hash,updated_at,completed_at)
          ON pr_agent_harness.eval_runs TO pr_agent_app;
        GRANT UPDATE (child_run_id,status,artifact_hash,score_json,score_hash,usage_json,latency_ms,error_code,updated_at,completed_at)
          ON pr_agent_harness.eval_results TO pr_agent_app;
        REVOKE INSERT, UPDATE, DELETE ON pr_agent_harness.evolution_release_qualifications,
          pr_agent_harness.evolution_release_assignments, pr_agent_harness.evolution_release_requests,
          pr_agent_harness.evolution_release_decisions, pr_agent_harness.evolution_release_receipts,
          pr_agent_harness.evolution_run_assignments FROM pr_agent_app;
        GRANT SELECT ON pr_agent_harness.evolution_release_qualifications,
          pr_agent_harness.evolution_release_assignments, pr_agent_harness.evolution_release_requests,
          pr_agent_harness.evolution_release_decisions, pr_agent_harness.evolution_release_receipts,
          pr_agent_harness.evolution_run_assignments TO pr_agent_app;
        GRANT INSERT (id,tenant_id,integration_id,candidate_id,dataset_id,dataset_version,validation_evaluation_id,
          holdout_evaluation_id,policy_json,policy_hash,evidence_json,evidence_hash,created_by_actor_type,created_by_actor_id,command_key,request_hash)
          ON pr_agent_harness.evolution_release_qualifications TO pr_agent_app;
        GRANT INSERT (tenant_id,integration_id,state,routing,candidate_id,qualification_id,version,fraction_bps,salt,activated_at,promoted_at)
          ON pr_agent_harness.evolution_release_assignments TO pr_agent_app;
        GRANT UPDATE (state,routing,candidate_id,qualification_id,version,fraction_bps,activated_at,promoted_at,updated_at)
          ON pr_agent_harness.evolution_release_assignments TO pr_agent_app;
        GRANT INSERT (id,tenant_id,integration_id,target,candidate_id,qualification_id,expected_assignment_version,candidate_bps,
          maker_actor_type,maker_actor_id,command_key,request_hash,expires_at)
          ON pr_agent_harness.evolution_release_requests TO pr_agent_app;
        GRANT UPDATE (status,consumed_at,updated_at,revoke_command_key,revoke_request_hash)
          ON pr_agent_harness.evolution_release_requests TO pr_agent_app;
        GRANT INSERT (tenant_id,integration_id,request_id,decision,checker_actor_type,checker_actor_id,command_key,request_hash)
          ON pr_agent_harness.evolution_release_decisions TO pr_agent_app;
        GRANT INSERT (tenant_id,integration_id,request_id,kind,assignment_version,before_json,after_json,evidence_json,evidence_hash,actor_type,actor_id,command_key,request_hash)
          ON pr_agent_harness.evolution_release_receipts TO pr_agent_app;
        GRANT INSERT (tenant_id,integration_id,run_id,assignment_version,routing,selection,bucket,candidate_id,qualification_id,
          release_receipt_id,review_text_json,review_text_hash,prompt_hash,tool_hash,selection_hash)
          ON pr_agent_harness.evolution_run_assignments TO pr_agent_app;
    `);
    let verifier = await pool.query("SELECT 1 FROM pg_roles WHERE rolname='pr_agent_verifier'");
    const verifierPassword = process.env.HARNESS_VERIFIER_PASSWORD;
    if (!verifier.rowCount && verifierPassword) {
      if (verifierPassword.length < 16 || verifierPassword.length > 1024) {
        throw new Error("HARNESS_VERIFIER_PASSWORD must contain 16-1024 characters");
      }
      const ddl = await pool.query<{ sql: string }>(
        `SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',
          'pr_agent_verifier',$1::text) AS sql`, [verifierPassword]);
      await pool.query(ddl.rows[0]!.sql);
      verifier = await pool.query("SELECT 1 FROM pg_roles WHERE rolname='pr_agent_verifier'");
    }
    if (verifier.rowCount) await pool.query(`
      GRANT USAGE ON SCHEMA pr_agent_harness TO pr_agent_verifier;
      GRANT EXECUTE ON FUNCTION pr_agent_harness.claim_verification_job(text,integer),
        pr_agent_harness.heartbeat_verification_job(uuid,uuid,text,bigint,integer),
        pr_agent_harness.complete_verification_job(uuid,uuid,text,bigint,jsonb,text),
        pr_agent_harness.fail_verification_job(uuid,uuid,text,bigint,text,integer) TO pr_agent_verifier;
      REVOKE ALL ON pr_agent_harness.verification_jobs,pr_agent_harness.agent_runs,
        pr_agent_harness.fix_verifications FROM pr_agent_verifier;
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
  } else if (command === "execution-switch") {
    const fields = parseFields(args, ["--tenant", "--id", "--version", "--mode", "--evidence"]);
    const mode = fields.get("--mode");
    if (mode !== "legacy_sync" && mode !== "harness_async") {
      throw new Error("Execution mode must be legacy_sync or harness_async");
    }
    console.log(JSON.stringify(await authority.switchExecution({
      tenantId: fields.get("--tenant")!, integrationId: fields.get("--id")!,
      expectedVersion: Number(fields.get("--version")), mode, evidence: fields.get("--evidence")!,
      actor: await administrativeActor(), actorType: "service",
    })));
  } else if (command === "retention") {
    const fields = parseFields(args, ["--tenant", "--action"], ["--days", "--limit"]);
    const action = fields.get("--action");
    if (action !== "preview" && action !== "apply") throw new Error("Retention action must be preview or apply");
    const request = { tenantId: fields.get("--tenant")!,
      olderThanDays: fields.has("--days") ? Number(fields.get("--days")) : undefined,
      limit: fields.has("--limit") ? Number(fields.get("--limit")) : undefined };
    console.log(JSON.stringify(await new HarnessMaintenanceStore(pool)[action](request)));
  } else if (command === "snapshot-retention") {
    const fields = parseFields(args, ["--action"], ["--days", "--limit"]);
    const action = fields.get("--action");
    if (action !== "preview" && action !== "apply") throw new Error("Snapshot retention action must be preview or apply");
    const root = process.env.FIX_VERIFIER_SNAPSHOT_ROOT?.trim();
    if (!root) throw new Error("FIX_VERIFIER_SNAPSHOT_ROOT is required for snapshot retention");
    console.log(JSON.stringify(await collectFixSnapshots({ db, root, apply: action === "apply",
      olderThanDays: fields.has("--days") ? Number(fields.get("--days")) : undefined,
      limit: fields.has("--limit") ? Number(fields.get("--limit")) : undefined })));
  } else if (command === "dataset-retire") {
    const fields = parseFields(args, ["--tenant", "--dataset", "--version"]);
    console.log(JSON.stringify(await new EvolutionDatasetMaintenanceStore(pool).retire({
      tenantId: fields.get("--tenant")!, datasetId: fields.get("--dataset")!, expectedVersion: Number(fields.get("--version")) })));
  } else if (command === "dataset-purge") {
    const fields = parseFields(args, ["--tenant", "--dataset"]);
    console.log(JSON.stringify(await new EvolutionDatasetMaintenanceStore(pool).purge({
      tenantId: fields.get("--tenant")!, datasetId: fields.get("--dataset")! })));
  } else if (command === "metrics") {
    const fields = parseFields(args, ["--tenant", "--id"]);
    console.log(JSON.stringify(await new HarnessMetricsStore(db).snapshot(fields.get("--tenant")!, fields.get("--id")!)));
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
    throw new Error("Usage: harness migrate | bind | configure | authority | execution-drain | execution-resume | execution-switch | retention | snapshot-retention | dataset-retire | dataset-purge | metrics | inspect | control (see backend/HARNESS.md)");
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
