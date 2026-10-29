import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { Pool } from "pg";

import { BASELINE_REVIEW_TEXT, reviewTextHashes } from "../src/review/strategy/text-components.js";
import type { EvolutionProposalSource } from "../src/evolution/candidate-contracts.js";
import { PgEvolutionCandidateStore } from "../src/evolution/candidate-store.js";
import { RuntimeDatabase } from "../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../src/agent-runtime/postgres/migrations.js";
import type { RunLease } from "../src/agent-runtime/runs/contracts.js";
import type { RunPrincipal } from "../src/agent-runtime/runs/control-contracts.js";
import { fingerprint } from "../src/agent-runtime/versions.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) test.skip("Evolution proposal PostgreSQL tests require Docker HARNESS_TEST_DATABASE_URL", () => {});
else {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!databaseName.startsWith("harness_test_")) throw new Error("evolution proposal tests require a disposable database");
  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  const role = `evolution_proposal_${process.pid}`; const password = "evolution-proposal-test";
  const tenantId = randomUUID(); const integrationId = randomUUID(); const runId = randomUUID();
  const datasetId = randomUUID(); const stepId = randomUUID(); const jobId = randomUUID();
  const hash = fingerprint("component"); const manifestHash = fingerprint("dataset-manifest");
  const hashes = reviewTextHashes(BASELINE_REVIEW_TEXT);
  const sourceWithoutHash = { schemaVersion: 1 as const, datasetId, datasetVersion: 2, datasetManifestHash: manifestHash,
    baselinePromptText: BASELINE_REVIEW_TEXT.prompt_text,
    baselineToolDescriptionText: BASELINE_REVIEW_TEXT.tool_description_text,
    baselinePromptHash: hashes.promptHash, baselineToolHash: hashes.toolHash,
    developmentCases: [{ caseId: randomUUID(), sourceRunId: randomUUID(), repository: "acme/repo",
      sourceArtifactHash: fingerprint("artifact"), labelSetHash: fingerprint("labels"), expectedFindings: [] }] };
  const source: EvolutionProposalSource = { ...sourceWithoutHash, sourceHash: fingerprint(sourceWithoutHash) };
  const candidate = { schemaVersion: 1 as const, prompt_text: "Prefer actionable changed-line defects.",
    tool_description_text: "Read exact ranges before making a finding." };
  const lease: RunLease = { tenantId, integrationId, runId, jobId, owner: "proposal-worker", epoch: 1,
    jobAttempt: 1, authorityGeneration: 1, executionModeGeneration: 1,
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(), leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    baseSha: manifestHash, headSha: manifestHash, workflowVersionHash: hash, promptVersionHash: hash,
    modelVersionHash: hash, toolVersionHash: hash, policyVersionHash: hash, runtimeVersionHash: hash,
    input: { schemaVersion: 1, workflow: "evolution.propose.v1", datasetId, datasetVersion: 2,
      datasetManifestHash: manifestHash, sourceHash: source.sourceHash }, limits: {}, runtimeConfig: {} };
  let app: Pool; let store: PgEvolutionCandidateStore;

  before(async () => {
    await migrateRuntime(admin);
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA pr_agent_harness TO ${role}`);
    await admin.query(`GRANT SELECT ON pr_agent_harness.agent_runs,pr_agent_harness.agent_steps,
      pr_agent_harness.evolution_proposal_sources,pr_agent_harness.evolution_candidates TO ${role}`);
    await admin.query(`GRANT UPDATE ON pr_agent_harness.agent_runs TO ${role}`);
    await admin.query(`GRANT INSERT ON pr_agent_harness.evolution_candidates TO ${role}`);
    await admin.query(`INSERT INTO pr_agent_harness.integration_bindings
      (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,credential_ref,
       publication_state,publication_generation,authority_version,review_execution_mode,execution_mode_generation,
       review_execution_state,quiescence_receipt)
      VALUES ($1,$2,'github','https://github.example.test','acme/repo',1,1,'env:GITHUB_TOKEN',
       'active',1,1,'harness_async',1,'active','{}'::jsonb)`, [integrationId, tenantId]);
    await admin.query(`INSERT INTO pr_agent_harness.eval_datasets
      (id,tenant_id,name,status,version,curator_actor_type,curator_actor_id,split_policy_json,split_policy_hash,
       manifest_hash,case_count,dev_count,validation_count,holdout_count,frozen_at)
      VALUES ($1,$2,'proposal-source','frozen',2,'user','curator',
       '{"schemaVersion":1}'::jsonb,$3,$4,1,1,0,0,clock_timestamp())`,
    [datasetId, tenantId, fingerprint("split-policy"), manifestHash]);
    await admin.query(`INSERT INTO pr_agent_harness.agent_runs
      (id,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,request_hash,
       run_type,base_sha,head_sha,workflow_version_hash,prompt_version_hash,model_version_hash,tool_version_hash,
       policy_version_hash,runtime_version_hash,input_json,status,version,lease_owner,lease_expires_at,lease_epoch,
       authority_generation,execution_mode_generation,deadline_at,limits_json,runtime_config_json)
      VALUES ($1,$2,$3,'user','curator','evolution.propose.v1','proposal-key',$4,'evolution.propose.v1',$5,$5,
       $4,$4,$4,$4,$4,$4,$6::jsonb,'running',1,'proposal-worker',clock_timestamp()+interval '10 minutes',1,
       1,1,clock_timestamp()+interval '1 hour','{}'::jsonb,'{}'::jsonb)`,
    [runId, tenantId, integrationId, hash, manifestHash, JSON.stringify(lease.input)]);
    await admin.query(`INSERT INTO pr_agent_harness.evolution_proposal_sources
      (tenant_id,proposal_run_id,dataset_id,dataset_version,dataset_manifest_hash,baseline_prompt_hash,
       baseline_tool_hash,source_hash,source_json,created_by_actor_type,created_by_actor_id)
      VALUES ($1,$2,$3,2,$4,$5,$6,$7,$8::jsonb,'user','curator')`,
    [tenantId, runId, datasetId, manifestHash, hashes.promptHash, hashes.toolHash, source.sourceHash, JSON.stringify(source)]);
    await admin.query(`INSERT INTO pr_agent_harness.agent_steps
      (id,tenant_id,run_id,step_key,step_kind,input_hash,status,output_hash,output_json,last_lease_epoch,attempt_count,completed_at)
      VALUES ($1,$2,$3,'evolution.proposal.model','model',$4,'succeeded',$5,$6::jsonb,1,1,clock_timestamp())`,
    [stepId, tenantId, runId, fingerprint("model-input"), fingerprint(candidate), JSON.stringify({ value: candidate })]);
    const url = new URL(databaseUrl); url.username = role; url.password = password;
    app = new Pool({ connectionString: url.toString(), max: 2 }); store = new PgEvolutionCandidateStore(new RuntimeDatabase(app));
  });

  after(async () => { await app?.end(); await admin.query(`DROP OWNED BY ${role}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`); await admin.end(); });

  async function seedProposalRun(candidateRunId: string): Promise<RunLease> {
    await admin.query(`INSERT INTO pr_agent_harness.agent_runs
      (id,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,request_hash,
       run_type,base_sha,head_sha,workflow_version_hash,prompt_version_hash,model_version_hash,tool_version_hash,
       policy_version_hash,runtime_version_hash,input_json,status,version,lease_owner,lease_expires_at,lease_epoch,
       authority_generation,execution_mode_generation,deadline_at,limits_json,runtime_config_json)
      SELECT $1::uuid,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,$1::text,request_hash,
       run_type,base_sha,head_sha,workflow_version_hash,prompt_version_hash,model_version_hash,tool_version_hash,
       policy_version_hash,runtime_version_hash,input_json,'running',1,'proposal-worker',
       clock_timestamp()+interval '10 minutes',1,authority_generation,execution_mode_generation,
       clock_timestamp()+interval '1 hour',limits_json,runtime_config_json
      FROM pr_agent_harness.agent_runs WHERE tenant_id=$2 AND id=$3`, [candidateRunId, tenantId, runId]);
    await admin.query(`INSERT INTO pr_agent_harness.evolution_proposal_sources
      (tenant_id,proposal_run_id,dataset_id,dataset_version,dataset_manifest_hash,baseline_prompt_hash,
       baseline_tool_hash,source_hash,source_json,created_by_actor_type,created_by_actor_id)
      SELECT tenant_id,$1,dataset_id,dataset_version,dataset_manifest_hash,baseline_prompt_hash,
       baseline_tool_hash,source_hash,source_json,created_by_actor_type,created_by_actor_id
      FROM pr_agent_harness.evolution_proposal_sources WHERE tenant_id=$2 AND proposal_run_id=$3`,
    [candidateRunId, tenantId, runId]);
    await admin.query(`INSERT INTO pr_agent_harness.agent_steps
      (tenant_id,run_id,step_key,step_kind,input_hash,status,output_hash,output_json,last_lease_epoch,attempt_count,completed_at)
      SELECT tenant_id,$1,step_key,step_kind,input_hash,status,output_hash,output_json,last_lease_epoch,attempt_count,completed_at
      FROM pr_agent_harness.agent_steps WHERE tenant_id=$2 AND run_id=$3`, [candidateRunId, tenantId, runId]);
    return { ...lease, runId: candidateRunId };
  }

  async function finishRun(candidateRunId: string, status: "succeeded" | "failed" | "cancelled"): Promise<void> {
    await admin.query(`UPDATE pr_agent_harness.agent_runs SET status=$3,lease_owner=NULL,lease_expires_at=NULL,
      finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
    [tenantId, candidateRunId, status]);
  }

  test("candidate persistence is strict, immutable, owner-scoped, and research-draft only", async () => {
    const saved = await store.saveCandidate(lease, "evolution.proposal.model", candidate, fingerprint("model-config"));
    assert.equal(saved.status, "research_draft"); assert.deepEqual(saved.candidate, candidate);
    assert.equal((await store.saveCandidate(lease, "evolution.proposal.model", candidate,
      fingerprint("model-config"))).id, saved.id);
    await assert.rejects(store.saveCandidate(lease, "evolution.proposal.model",
      { ...candidate, prompt_text: "different" }, fingerprint("model-config")));
    const owner: RunPrincipal = { tenantId, integrationId, actorType: "user", subjectId: "curator",
      permissions: ["evaluations:read"] };
    await finishRun(runId, "failed");
    await assert.rejects(store.read(owner, saved.id), /not found/i);

    const cancelledRunId = randomUUID(); const cancelledLease = await seedProposalRun(cancelledRunId);
    const cancelled = await store.saveCandidate(cancelledLease, "evolution.proposal.model", candidate,
      fingerprint("model-config"));
    await finishRun(cancelledRunId, "cancelled");
    await assert.rejects(store.read(owner, cancelled.id), /not found/i);

    const succeededRunId = randomUUID(); const succeededLease = await seedProposalRun(succeededRunId);
    const succeeded = await store.saveCandidate(succeededLease, "evolution.proposal.model", candidate,
      fingerprint("model-config"));
    await assert.rejects(store.read(owner, succeeded.id), /not found/i);
    await finishRun(succeededRunId, "succeeded");
    assert.equal((await store.read(owner, succeeded.id)).candidateHash, succeeded.candidateHash);
    await assert.rejects(store.read({ ...owner, subjectId: "other" }, succeeded.id), /not found/i);
    await assert.rejects(app.query("DELETE FROM pr_agent_harness.evolution_candidates"), /permission denied/i);
    await assert.rejects(admin.query(`UPDATE pr_agent_harness.evolution_candidates SET status='research_draft',
      candidate_json='{"purged":true}'::jsonb WHERE tenant_id=$1 AND id=$2`, [tenantId, saved.id]), /immutable|purge/i);
    const identity = (await admin.query<{ candidate_hash: string; provenance_json: unknown }>(
      `SELECT candidate_hash,provenance_json FROM pr_agent_harness.evolution_candidates WHERE tenant_id=$1 AND id=$2`,
      [tenantId, succeeded.id])).rows[0]!;
    await admin.query(`UPDATE pr_agent_harness.evolution_candidates
      SET candidate_json='{"purged":true}'::jsonb,content_purged_at=clock_timestamp()
      WHERE tenant_id=$1 AND id=$2`, [tenantId, succeeded.id]);
    const purged = (await admin.query<{ candidate_hash: string; provenance_json: unknown; candidate_json: unknown }>(
      `SELECT candidate_hash,provenance_json,candidate_json FROM pr_agent_harness.evolution_candidates
       WHERE tenant_id=$1 AND id=$2`, [tenantId, succeeded.id])).rows[0]!;
    assert.equal(purged.candidate_hash, identity.candidate_hash); assert.deepEqual(purged.provenance_json, identity.provenance_json);
    assert.deepEqual(purged.candidate_json, { purged: true });
  });
}
