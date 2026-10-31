import type { PoolClient } from "pg";

import type { PublicationBinding } from "../../agent-runtime/authority/publication-authority.js";
import { lockCurrentBindingCapability } from "../../agent-runtime/authority/capability-guard.js";
import { assertRuntimeCapability } from "../../agent-runtime/runtime/capabilities.js";
import { PgRunArtifactStore } from "../../agent-runtime/artifacts/index.js";
import {
  getModelExecutionPolicy,
  reserveRunBudgetInTransaction,
  type ModelExecutionPolicy,
} from "../../agent-runtime/budget/model-budget-store.js";
import type { RuntimeDatabase } from "../../agent-runtime/postgres/database.js";
import { createRunInTransaction, type CreateRunInput } from "../../agent-runtime/postgres/run-store.js";
import {
  requireRunPermission,
  RunControlError,
  type RunPermission,
  type RunPrincipal,
} from "../../agent-runtime/runs/control-contracts.js";
import { fingerprint, runtimeVersionManifest } from "../../agent-runtime/versions.js";
import { resolveModelConfiguration } from "../../model/configuration.js";
import type { DeepReviewArtifact, FindingCandidate } from "../../review/deep/contracts.js";
import { MANAGED_PROMPT_CATALOG, promptTemplateHash } from "../prompts/index.js";
import {
  JUDGE_RUBRIC,
  judgeRequestSchema,
  judgeRubricSchema,
  judgeSourceSchema,
  type JudgeRequest,
  type JudgeSource,
} from "./contracts.js";

const MAX_SOURCE_BYTES = 96 * 1024;
const MAX_RUN_MS = 10 * 60_000;
const JUDGE_PERMISSION = "quality:evaluators:run" as RunPermission;

export interface JudgeReviewSourceRow {
  status: string;
  run_type: string;
  base_sha: string;
  head_sha: string;
  artifact_json: DeepReviewArtifact;
  content_hash: string;
  content_purged_at: Date | null;
}

interface CollectionStepRow {
  output_json: Record<string, unknown> | null;
  output_hash: string;
  result_ref: string | null;
}

export interface JudgeAdmission {
  id: string;
  status: string;
  version: number;
  created: boolean;
}

export async function admitJudgeRun(input: {
  db: RuntimeDatabase;
  principal: RunPrincipal;
  binding: PublicationBinding;
  commandKey: string;
  request: JudgeRequest | unknown;
}): Promise<JudgeAdmission> {
  requireRunPermission(input.principal, JUDGE_PERMISSION);
  requireRunPermission(input.principal, "runs:read");
  assertRuntimeCapability("evolution");
  assertBindingScope(input.principal, input.binding);
  const request = judgeRequestSchema.parse(input.request);
  const requestHash = fingerprint(request);
  const createScope = `eval.judge.v1:${input.binding.id}`;
  const createKey = `judge:${boundedCommandKey(input.commandKey)}`;
  const duplicate = await findDuplicate(input.db, input.principal, createScope, createKey);
  if (duplicate) {
    assertDuplicate(duplicate, input.principal, requestHash);
    return { id: duplicate.id, status: duplicate.status, version: Number(duplicate.version), created: false };
  }

  const created = await input.db.transaction(input.principal.tenantId, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,1830))",
      [input.principal.tenantId]);
    await lockCurrentBindingCapability(client, {
      tenantId: input.principal.tenantId,
      integrationId: input.principal.integrationId,
      capability: "evolution",
    });
    const source = await loadJudgeSource(client, input.db, input.principal, request);
    const creation = await buildJudgeRunCreation(input.binding, input.principal,
      createScope, createKey, requestHash, source, request);
    const modelPolicy = creation.runtimeConfig?.modelPolicy as ModelExecutionPolicy | undefined;
    if (!modelPolicy) throw new Error("Judge model policy is missing");
    const run = await createRunInTransaction(client, {
      ...creation,
      admission: (transaction, runId) => reserveRunBudgetInTransaction(transaction, {
        tenantId: input.principal.tenantId,
        runId,
        policy: modelPolicy,
      }),
    });
    const owner = await client.query<{ created_by_actor_type: string; created_by_actor_id: string }>(
      `SELECT created_by_actor_type,created_by_actor_id
       FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND integration_id=$2 AND id=$3`,
      [input.principal.tenantId, input.principal.integrationId, run.id],
    );
    if (owner.rows[0]?.created_by_actor_type !== input.principal.actorType
        || owner.rows[0]?.created_by_actor_id !== input.principal.subjectId) {
      throw new RunControlError("IDEMPOTENCY_CONFLICT", 409,
        "Idempotency key belongs to another Judge actor");
    }
    return run;
  });
  return { id: created.id, status: created.status, version: created.version, created: created.created };
}

export async function buildJudgeRunCreation(
  binding: PublicationBinding,
  principal: RunPrincipal,
  createScope: string,
  createKey: string,
  requestHash: string,
  source: JudgeSource,
  request: JudgeRequest,
): Promise<CreateRunInput> {
  const { provider, model } = resolveModelConfiguration();
  const modelPolicy = getModelExecutionPolicy(provider, model);
  const versions = await runtimeVersionManifest(modelPolicy);
  const rubric = judgeRubricSchema.parse(JUDGE_RUBRIC);
  const judgePolicy = {
    schemaVersion: 1,
    maxFindings: 20,
    maxInputBytes: 128 * 1024,
    maxOutputTokens: Math.min(4_096, modelPolicy.maxOutputTokens),
    maxRunMs: MAX_RUN_MS,
    rubric,
    rubricHash: fingerprint(rubric),
  };
  return {
    tenantId: principal.tenantId,
    integrationId: principal.integrationId,
    actorType: principal.actorType,
    actorId: principal.subjectId,
    createScope,
    createKey,
    requestHash,
    runType: "eval.judge.v1",
    baseSha: source.baseSha,
    headSha: source.headSha,
    workflowVersionHash: fingerprint({ base: versions.workflowVersionHash, workflow: "eval.judge.v1" }),
    promptVersionHash: fingerprint({
      base: versions.promptVersionHash,
      prompt: promptTemplateHash(MANAGED_PROMPT_CATALOG["evaluation.judge.system"].template),
      rubric: judgePolicy.rubricHash,
    }),
    modelVersionHash: versions.modelVersionHash,
    toolVersionHash: fingerprint({ base: versions.toolVersionHash, tools: "none" }),
    policyVersionHash: fingerprint({ base: versions.policyVersionHash, judgePolicy }),
    runtimeVersionHash: versions.runtimeVersionHash,
    input: {
      schemaVersion: 1,
      workflow: "eval.judge.v1",
      sourceRunId: request.sourceRunId,
      expectedArtifactHash: request.expectedArtifactHash,
      sourceHash: source.sourceHash,
    },
    parentRunId: request.sourceRunId,
    authorityGeneration: binding.generation,
    bindingAuthorityVersion: binding.version,
    executionModeGeneration: binding.executionModeGeneration ?? 0,
    deadlineAt: new Date(Date.now() + MAX_RUN_MS).toISOString(),
    runtimeConfig: {
      schemaVersion: 1,
      workflow: "eval.judge.v1",
      pollMs: 1_000,
      leaseTtlMs: 60_000,
      heartbeatMs: 15_000,
      sweepMs: 5_000,
      maxRunMs: MAX_RUN_MS,
      maxJobAttempts: 3,
      maxStepAttempts: 3,
      maxCheckpointBytes: 4 * 1024 * 1024,
      modelPolicy,
      judgePolicy,
      judgeSource: source,
    },
    limits: {
      maxRunMs: MAX_RUN_MS,
      maxJobAttempts: 3,
      maxStepAttempts: 3,
      model: modelPolicy.runLimits,
    },
  };
}

async function loadJudgeSource(
  client: PoolClient,
  db: RuntimeDatabase,
  principal: RunPrincipal,
  request: JudgeRequest,
): Promise<JudgeSource> {
  const result = await client.query<JudgeReviewSourceRow>(
    `SELECT r.status,r.run_type,r.base_sha,r.head_sha,
            a.artifact_json,a.content_hash,a.content_purged_at
     FROM pr_agent_harness.agent_runs r
     JOIN pr_agent_harness.review_artifacts a
       ON a.tenant_id=r.tenant_id AND a.integration_id=r.integration_id AND a.run_id=r.id
     WHERE r.tenant_id=$1 AND r.integration_id=$2 AND r.id=$3
     FOR SHARE OF r,a`,
    [principal.tenantId, principal.integrationId, request.sourceRunId],
  );
  const row = result.rows[0];
  if (!row) throw unavailable("Judge source was not found in this binding");
  const artifact = validateJudgeSourceArtifact(row, principal, request);
  const collectionStep = await client.query<CollectionStepRow>(
    `SELECT output_json,output_hash,result_ref
     FROM pr_agent_harness.agent_steps
     WHERE tenant_id=$1 AND run_id=$2
       AND step_key IN ('github.collect_context.v1','gitlab.collect_context.v1')
       AND step_kind='tool' AND status='succeeded'
     ORDER BY completed_at DESC NULLS LAST LIMIT 1`,
    [principal.tenantId, request.sourceRunId],
  );
  const step = collectionStep.rows[0];
  if (!step) throw unavailable("Deep Review collection is unavailable");
  let collection: unknown;
  try {
    collection = await new PgRunArtifactStore(db).readStepOutputValueInTransaction(client, {
      tenantId: principal.tenantId,
      integrationId: principal.integrationId,
      runId: request.sourceRunId,
    }, { resultRef: step.result_ref, output: step.output_json, outputHash: step.output_hash });
  } catch {
    throw unavailable("Deep Review collection is corrupt or has been purged");
  }
  const collectionRecord = completeCollection(collection);
  const findings = acceptedFindings(artifact);
  if (findings.length > 20) throw unavailable("Deep Review has more findings than the Judge limit");
  const projectedCollection = projectCollection(collectionRecord, findings);
  const withoutHash = {
    schemaVersion: 1 as const,
    sourceRunId: request.sourceRunId,
    sourceArtifactHash: row.content_hash,
    collectionHash: step.output_hash,
    repository: artifact.identity.repository,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    findings,
    collection: projectedCollection,
  };
  const source = judgeSourceSchema.parse({ ...withoutHash, sourceHash: fingerprint(withoutHash) });
  if (Buffer.byteLength(JSON.stringify(source), "utf8") > MAX_SOURCE_BYTES) {
    throw unavailable("Judge source exceeds the bounded model input");
  }
  return source;
}

function assertCompleteArtifact(
  artifact: DeepReviewArtifact,
  principal: RunPrincipal,
  sourceRunId: string,
): void {
  if (artifact.workflowId !== "review.deep.v1" || artifact.publicationMode !== "shadow"
      || artifact.analysisStatus !== "complete" || artifact.sourceCoverage.status !== "complete"
      || artifact.coverage.some((item) => item.status !== "complete")
      || artifact.identity.tenantId !== principal.tenantId
      || artifact.identity.integrationId !== principal.integrationId
      || artifact.identity.runId !== sourceRunId) {
    throw unavailable("Judge source is not a complete immutable Deep Review");
  }
}

export function validateJudgeSourceArtifact(
  row: JudgeReviewSourceRow | undefined,
  principal: RunPrincipal,
  request: JudgeRequest,
): DeepReviewArtifact {
  if (!row) throw unavailable("Judge source was not found in this binding");
  if (row.run_type !== "review.deep.v1") {
    throw unavailable("Only a production Deep Review can be judged");
  }
  if (row.status !== "succeeded" || row.content_purged_at) {
    throw unavailable("Judge source is incomplete or has been purged");
  }
  if (row.content_hash !== request.expectedArtifactHash
      || fingerprint(row.artifact_json) !== row.content_hash) {
    throw unavailable("Judge source artifact hash does not match");
  }
  if (row.artifact_json.identity.baseSha !== row.base_sha
      || row.artifact_json.identity.headSha !== row.head_sha) {
    throw unavailable("Judge source artifact revision does not match");
  }
  assertCompleteArtifact(row.artifact_json, principal, request.sourceRunId);
  return row.artifact_json;
}

function acceptedFindings(artifact: DeepReviewArtifact): JudgeSource["findings"] {
  const accepted = new Set(artifact.gateDecisions.filter((item) => item.accepted)
    .map((item) => item.candidateId));
  return artifact.candidates.filter((item) => accepted.has(item.id)).map((item: FindingCandidate) => ({
    id: item.id,
    severity: item.severity,
    title: item.title,
    body: item.body,
    location: item.location,
    evidenceIds: [...item.evidenceIds],
  }));
}

function completeCollection(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw unavailable("Deep Review collection is invalid");
  }
  const collection = value as Record<string, unknown>;
  const coverage = collection.coverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)
      || (coverage as Record<string, unknown>).status !== "complete"
      || collection.filesTruncated === true || !Array.isArray(collection.files)) {
    throw unavailable("Deep Review collection is not complete");
  }
  return collection;
}

function projectCollection(
  collection: Record<string, unknown>,
  findings: JudgeSource["findings"],
): Record<string, unknown> {
  const paths = new Set(findings.map((item) => item.location.path));
  const files = (collection.files as unknown[]).filter((item) => item && typeof item === "object"
    && !Array.isArray(item) && paths.has(String((item as Record<string, unknown>).newPath)));
  const rawInput = collection.input;
  const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
    ? rawInput as Record<string, unknown> : {};
  const changedFiles = Array.isArray(input.changedFiles)
    ? input.changedFiles.filter((item) => item && typeof item === "object" && !Array.isArray(item)
      && paths.has(String((item as Record<string, unknown>).newPath)))
    : [];
  return JSON.parse(JSON.stringify({
    input: { ...input, changedFiles },
    files,
    coverage: collection.coverage,
  })) as Record<string, unknown>;
}

function assertBindingScope(principal: RunPrincipal, binding: PublicationBinding): void {
  if (principal.tenantId !== binding.tenantId || principal.integrationId !== binding.id
      || binding.state !== "active") {
    throw new RunControlError("RUN_NOT_FOUND", 404, "Binding was not found");
  }
}

function boundedCommandKey(value: string): string {
  const parsed = value.trim();
  if (!parsed || parsed.length > 200) throw new RunControlError("INVALID_COMMAND_KEY", 400, "Command key is invalid");
  return parsed;
}

function unavailable(message: string): RunControlError {
  return new RunControlError("JUDGE_SOURCE_UNAVAILABLE", 409, message);
}

interface DuplicateRow {
  id: string;
  status: string;
  version: string;
  request_hash: string;
  created_by_actor_type: string;
  created_by_actor_id: string;
}

async function findDuplicate(
  db: RuntimeDatabase,
  principal: RunPrincipal,
  createScope: string,
  createKey: string,
): Promise<DuplicateRow | undefined> {
  const result = await db.transaction(principal.tenantId, (client) => client.query<DuplicateRow>(
    `SELECT id,status,version,request_hash,created_by_actor_type,created_by_actor_id
     FROM pr_agent_harness.agent_runs
     WHERE tenant_id=$1 AND integration_id=$2 AND create_scope=$3 AND create_key=$4`,
    [principal.tenantId, principal.integrationId, createScope, createKey],
  ));
  return result.rows[0];
}

function assertDuplicate(row: DuplicateRow, principal: RunPrincipal, requestHash: string): void {
  if (row.request_hash !== requestHash || row.created_by_actor_type !== principal.actorType
      || row.created_by_actor_id !== principal.subjectId) {
    throw new RunControlError("IDEMPOTENCY_CONFLICT", 409,
      "Idempotency key was used for another Judge request");
  }
}
