import type { PoolClient } from "pg";

import { BASELINE_REVIEW_TEXT, reviewTextHashes } from "../agents/text-components.js";
import type { PublicationBinding } from "../agent-runtime/authority/publication-authority.js";
import { getModelExecutionPolicy, reserveRunBudgetInTransaction, type ModelExecutionPolicy } from "../agent-runtime/budget/model-budget-store.js";
import type { RuntimeDatabase } from "../agent-runtime/postgres/database.js";
import { createRunInTransaction, type CreateRunInput } from "../agent-runtime/postgres/run-store.js";
import type { RunPrincipal } from "../agent-runtime/runs/control-contracts.js";
import { requireRunPermission } from "../agent-runtime/runs/control-contracts.js";
import { fingerprint, runtimeVersionManifest } from "../agent-runtime/versions.js";
import { redactRepositoryText } from "../integrations/shared/repository-read-tools.js";
import { resolveModelConfiguration } from "../review/ai-reviewer.js";
import { trustedLabelSetSchema } from "./feedback-contracts.js";
import type { EvolutionDevelopmentCaseSummary, EvolutionProposalRunInput, EvolutionProposalSource } from "./candidate-contracts.js";
import { EvolutionCandidateError, insertEvolutionProposalSource } from "./candidate-store.js";

const EVOLUTION_POLICY = Object.freeze({ schemaVersion: 1, maxCases: 500, maxInputBytes: 524_288,
  maxOutputTokens: 8_192, maxRunMs: 15 * 60_000 });

export interface EvolutionProposalAdmission {
  id: string; status: string; version: number; created: boolean;
}
export async function admitEvolutionProposalRun(input: {
  db: RuntimeDatabase; binding: PublicationBinding; principal: RunPrincipal; datasetId: string; commandKey: string;
}): Promise<EvolutionProposalAdmission> {
  requireRunPermission(input.principal, "evolution:propose");
  const requestHash = fingerprint({ datasetId: input.datasetId });
  const createScope = `evolution.propose.v1:${input.binding.id}`;
  const createKey = `proposal:${input.commandKey}`;
  const duplicate = await input.db.transaction(input.principal.tenantId, (client) => client.query<{
    id: string; status: string; version: string; request_hash: string; created_by_actor_type: string; created_by_actor_id: string;
  }>(`SELECT id,status,version,request_hash,created_by_actor_type,created_by_actor_id
      FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND integration_id=$2 AND create_scope=$3 AND create_key=$4`,
  [input.principal.tenantId, input.principal.integrationId, createScope, createKey]));
  if (duplicate.rows[0]) {
    const row = duplicate.rows[0];
    if (row.request_hash !== requestHash || row.created_by_actor_type !== input.principal.actorType
        || row.created_by_actor_id !== input.principal.subjectId) {
      throw new EvolutionCandidateError("IDEMPOTENCY_CONFLICT", 409, "Idempotency key was used for another proposal request");
    }
    return { id: row.id, status: row.status, version: Number(row.version), created: false };
  }
  const created = await input.db.transaction(input.principal.tenantId, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,1830))", [input.principal.tenantId]);
    const source = await loadProposalSource(client, input.principal, input.datasetId);
    const creation = await buildEvolutionProposalCreation(input.binding, input.principal, createScope, createKey,
      requestHash, source);
    const modelPolicy = creation.runtimeConfig?.modelPolicy as unknown as ModelExecutionPolicy | undefined;
    if (!modelPolicy) throw new Error("Evolution proposal model policy is missing");
    const run = await createRunInTransaction(client, { ...creation, admission: async (transaction, runId) => {
        await reserveRunBudgetInTransaction(transaction, { tenantId: input.principal.tenantId, runId,
          policy: modelPolicy });
        await insertEvolutionProposalSource(transaction, { tenantId: input.principal.tenantId, proposalRunId: runId,
          source, actorType: input.principal.actorType, actorId: input.principal.subjectId });
      } });
    const owner = await client.query<{ created_by_actor_type: string; created_by_actor_id: string }>(
      `SELECT created_by_actor_type,created_by_actor_id FROM pr_agent_harness.agent_runs
       WHERE tenant_id=$1 AND integration_id=$2 AND id=$3`,
      [input.principal.tenantId, input.principal.integrationId, run.id]);
    if (owner.rows[0]?.created_by_actor_type !== input.principal.actorType
        || owner.rows[0]?.created_by_actor_id !== input.principal.subjectId) {
      throw new EvolutionCandidateError("IDEMPOTENCY_CONFLICT", 409, "Idempotency key belongs to another actor");
    }
    return run;
  });
  return { id: created.id, status: created.status, version: created.version, created: created.created };
}

export async function buildEvolutionProposalCreation(binding: PublicationBinding, principal: RunPrincipal,
  createScope: string, createKey: string, requestHash: string, source: EvolutionProposalSource): Promise<CreateRunInput> {
  const { provider, model } = resolveModelConfiguration();
  const modelPolicy = getModelExecutionPolicy(provider, model); const base = await runtimeVersionManifest(modelPolicy);
  const evolutionPolicy = { ...EVOLUTION_POLICY,
    maxOutputTokens: Math.min(EVOLUTION_POLICY.maxOutputTokens, modelPolicy.maxOutputTokens) };
  const input: EvolutionProposalRunInput = { schemaVersion: 1, workflow: "evolution.propose.v1",
    datasetId: source.datasetId, datasetVersion: source.datasetVersion,
    datasetManifestHash: source.datasetManifestHash, sourceHash: source.sourceHash };
  return { tenantId: principal.tenantId, integrationId: principal.integrationId,
    actorType: principal.actorType, actorId: principal.subjectId, createScope, createKey, requestHash,
    runType: "evolution.propose.v1", baseSha: source.datasetManifestHash, headSha: source.datasetManifestHash,
    workflowVersionHash: fingerprint({ base: base.workflowVersionHash, workflow: "evolution.propose.v1" }),
    promptVersionHash: fingerprint({ base: base.promptVersionHash, baselinePromptHash: source.baselinePromptHash }),
    modelVersionHash: base.modelVersionHash,
    toolVersionHash: fingerprint({ base: base.toolVersionHash, tools: "none", baselineToolHash: source.baselineToolHash }),
    policyVersionHash: fingerprint({ base: base.policyVersionHash, policy: evolutionPolicy }),
    runtimeVersionHash: base.runtimeVersionHash, input: input as unknown as Record<string, unknown>,
    authorityGeneration: binding.generation, executionModeGeneration: binding.executionModeGeneration ?? 0,
    runtimeConfig: { schemaVersion: 1, workflow: "evolution.propose.v1", pollMs: 1_000, leaseTtlMs: 60_000,
      heartbeatMs: 15_000, sweepMs: 5_000, maxRunMs: EVOLUTION_POLICY.maxRunMs, maxJobAttempts: 3,
      maxStepAttempts: 3, maxCheckpointBytes: 4 * 1024 * 1024, modelPolicy, evolutionPolicy,
      reviewText: BASELINE_REVIEW_TEXT },
    limits: { maxRunMs: EVOLUTION_POLICY.maxRunMs, maxJobAttempts: 3, maxStepAttempts: 3, model: modelPolicy.runLimits } };
}

async function loadProposalSource(client: PoolClient, principal: RunPrincipal,
  datasetId: string): Promise<EvolutionProposalSource> {
  const dataset = await client.query<{ version: string; manifest_hash: string; dev_count: number }>(
    `SELECT version,manifest_hash,dev_count FROM pr_agent_harness.eval_datasets
     WHERE tenant_id=$1 AND id=$2 AND curator_actor_type=$3 AND curator_actor_id=$4
       AND status='frozen' AND content_purged_at IS NULL FOR SHARE`,
    [principal.tenantId, datasetId, principal.actorType, principal.subjectId]);
  const row = dataset.rows[0];
  if (!row?.manifest_hash) throw new EvolutionCandidateError("EVOLUTION_DATASET_UNAVAILABLE", 409,
    "A frozen curator-owned dataset is required");
  if (row.dev_count === 0) throw new EvolutionCandidateError("EVOLUTION_DATASET_EMPTY", 409, "Development split is empty");
  if (row.dev_count > EVOLUTION_POLICY.maxCases) throw new EvolutionCandidateError("EVOLUTION_DATASET_TOO_LARGE", 409,
    "Development split exceeds the bounded proposal input");
  const cases = await client.query<{ id: string; source_run_id: string; repository: string;
    source_artifact_hash: string; label_set_hash: string; label_set_json: unknown }>(
    `SELECT c.id,c.source_run_id,c.repository,c.source_artifact_hash,c.label_set_hash,c.label_set_json
     FROM pr_agent_harness.eval_cases c JOIN pr_agent_harness.trusted_review_label_sets l
       ON l.tenant_id=c.tenant_id AND l.id=c.label_set_id AND l.source_run_id=c.source_run_id
          AND l.label_set_hash=c.label_set_hash AND l.active
     WHERE c.tenant_id=$1 AND c.dataset_id=$2 AND c.split='development'
       AND c.content_purged_at IS NULL ORDER BY c.ordinal,c.id LIMIT $3`,
    [principal.tenantId, datasetId, EVOLUTION_POLICY.maxCases + 1]);
  if (cases.rowCount !== row.dev_count) {
    throw new EvolutionCandidateError("EVOLUTION_DATASET_UNAVAILABLE", 409,
      "Development labels changed after the dataset was frozen");
  }
  const summaries: EvolutionDevelopmentCaseSummary[] = cases.rows.map((item) => {
    const labels = trustedLabelSetSchema.parse(item.label_set_json);
    if (fingerprint(labels) !== item.label_set_hash) {
      throw new EvolutionCandidateError("EVOLUTION_DATASET_CORRUPT", 409, "Dataset label snapshot hash is invalid");
    }
    return { caseId: item.id, sourceRunId: item.source_run_id, repository: item.repository,
      sourceArtifactHash: item.source_artifact_hash, labelSetHash: item.label_set_hash,
      expectedFindings: labels.expectedFindings.map((finding) => ({ ...finding,
        title: redactRepositoryText(finding.title) })) };
  });
  const hashes = reviewTextHashes(BASELINE_REVIEW_TEXT);
  const withoutHash = { schemaVersion: 1 as const, datasetId, datasetVersion: Number(row.version),
    datasetManifestHash: row.manifest_hash, baselinePromptText: BASELINE_REVIEW_TEXT.prompt_text,
    baselineToolDescriptionText: BASELINE_REVIEW_TEXT.tool_description_text,
    baselinePromptHash: hashes.promptHash, baselineToolHash: hashes.toolHash,
    developmentCases: summaries };
  const source: EvolutionProposalSource = { ...withoutHash, sourceHash: fingerprint(withoutHash) };
  if (Buffer.byteLength(JSON.stringify(source), "utf8") > EVOLUTION_POLICY.maxInputBytes) {
    throw new EvolutionCandidateError("EVOLUTION_DATASET_TOO_LARGE", 409, "Development summaries exceed the bounded proposal input");
  }
  return source;
}
