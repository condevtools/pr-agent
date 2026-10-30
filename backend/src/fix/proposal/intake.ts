import { createHash } from "node:crypto";
import { z } from "zod";

import type { FindingCandidate } from "../../review/deep/contracts.js";
import type { FixRunInput, FixSource, VerificationPolicy } from "../contracts.js";
import { loadFixPolicyRegistry } from "./policy.js";
import { assertVerifierPolicy } from "../verification/sandbox-policy.js";
import { prepareSnapshotBundle } from "../persistence/snapshot-bundle.js";
import { GitHubRepositoryReadAdapter } from "../../integrations/github/repository/read-adapter.js";
import { GitLabRepositoryReadAdapter } from "../../integrations/gitlab/repository/read-adapter.js";
import { resolveModelConfiguration } from "../../model/configuration.js";
import type { PublicationBinding } from "../../agent-runtime/authority/publication-authority.js";
import { getModelExecutionPolicy, reserveRunBudgetInTransaction } from "../../agent-runtime/budget/model-budget-store.js";
import type { RuntimeDatabase } from "../../agent-runtime/postgres/database.js";
import { createRunInTransaction, type CreateRunInput } from "../../agent-runtime/postgres/run-store.js";
import { resolveReviewInput } from "../../review/intake/resolve-input.js";
import type { RunPrincipal } from "../../agent-runtime/runs/control-contracts.js";
import { runConflict, runNotFound } from "../../agent-runtime/runs/control-contracts.js";
import { reviewRunInputSchema, type ReviewRunInput } from "../../review/intake/run-input.js";
import { assertSafePath } from "../../repository/content-safety/repository-content.js";
import { publicationRuntimeForBinding } from "../../agent-runtime/runtime/publication.js";
import { fingerprint, runtimeVersionManifest } from "../../agent-runtime/versions.js";
import { PgRunArtifactStore, RUN_ARTIFACT_LIMITS } from "../../agent-runtime/artifacts/index.js";

const MAX_SNAPSHOT_FILES = 2_000;

const findingSchema: z.ZodType<FindingCandidate> = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), sourceRole: z.enum(["security", "correctness"]),
  severity: z.enum(["low", "medium", "high"]), title: z.string().min(1).max(300), body: z.string().min(1).max(4_000),
  location: z.object({ path: z.string().min(1).max(512), side: z.enum(["old", "new"]),
    startLine: z.number().int().positive(), endLine: z.number().int().positive() }).strict(),
  evidenceIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(500),
  crossFileEvidenceIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(500), suggestion: z.string().max(8_000).optional(),
}).strict();

export interface FixRunAdmissionResult { id: string; status: string; version: number; created: boolean }

export async function admitFixProposalRun(input: {
  db: RuntimeDatabase;
  binding: PublicationBinding;
  principal: RunPrincipal;
  sourceReviewRunId: string;
  commandKey: string;
  findingId: string;
}): Promise<FixRunAdmissionResult> {
  const requestHash = fingerprint({ sourceReviewRunId: input.sourceReviewRunId, findingId: input.findingId });
  const createScope = `fix.propose.v1:${input.binding.id}`;
  const createKey = `fix:${input.sourceReviewRunId}:${input.commandKey}`;
  const duplicate = await input.db.transaction(input.principal.tenantId, (client) => client.query<{
    id: string; status: string; version: string; request_hash: string;
  }>(`SELECT id,status,version,request_hash FROM pr_agent_harness.agent_runs
      WHERE tenant_id=$1 AND integration_id=$2 AND create_scope=$3 AND create_key=$4`,
  [input.principal.tenantId, input.principal.integrationId, createScope, createKey]));
  if (duplicate.rows[0]) {
    if (duplicate.rows[0].request_hash !== requestHash) throw runConflict("Idempotency key was used for a different fix request");
    return { id: duplicate.rows[0].id, status: duplicate.rows[0].status,
      version: Number(duplicate.rows[0].version), created: false };
  }
  const source = await loadAcceptedSource(input.db, input.principal, input.sourceReviewRunId, input.findingId);
  const policy = resolveServerFixPolicy();
  const current = await resolveReviewInput(input.binding, {
    workflow: "review.deep.v1", number: source.review.target.number, mode: source.review.mode, options: source.review.options,
  }, { key: `fix-head-check:${input.sourceReviewRunId}`, hash: requestHash });
  if (current.revision.headSha !== source.review.revision.headSha || current.revision.baseSha !== source.review.revision.baseSha
      || current.presentation.headBranch !== source.review.presentation.headBranch) {
    throw runConflict("Reviewed pull request head moved; run a new deep review before fixing");
  }
  const runtime = await publicationRuntimeForBinding(input.binding);
  const adapter = await repositoryAdapter(input.binding, source.review.revision.headSha, runtime.resolveCredential());
  const paths = (await adapter.listFiles()).filter(snapshotPathAllowed);
  if (paths.length === 0 || paths.length > MAX_SNAPSHOT_FILES) {
    throw runConflict("Bounded source snapshot file count exceeds the admission limit");
  }
  if (!paths.includes(source.finding.location.path) || !paths.includes(policy.dependencyLockPath)) {
    throw runConflict("Trusted finding or dependency lock is unavailable in the bounded source snapshot");
  }
  const files: Array<{ path: string; content: Uint8Array }> = [];
  let collectedBytes = 0;
  for (let offset = 0; offset < paths.length; offset += 6) {
    if (collectedBytes >= RUN_ARTIFACT_LIMITS.maxRawBytes) {
      throw runConflict("Bounded source snapshot exceeds the admission byte limit");
    }
    const batch = await Promise.all(paths.slice(offset, offset + 6).map(async (path) => {
      const file = await adapter.readFile(path);
      if (!file) throw runConflict(`Required fixed-revision source file is unavailable: ${path}`);
      return { path, content: file.bytes };
    }));
    for (const file of batch) {
      collectedBytes += file.content.byteLength;
      if (collectedBytes > RUN_ARTIFACT_LIMITS.maxRawBytes) {
        throw runConflict("Bounded source snapshot exceeds the admission byte limit");
      }
      files.push(file);
    }
  }
  const lock = files.find(({ path }) => path === policy.dependencyLockPath)!;
  if (sha256(lock.content) !== policy.dependencyLockHash) throw runConflict("Dependency lock does not match the trusted fix policy");
  const snapshot = await prepareSnapshotBundle({ headSha: source.review.revision.headSha,
    dependencyLockHash: policy.dependencyLockHash, files });
  const { sourceBundleHash, sourceBundleRef } = snapshot;
  const fixSource: Omit<FixSource, "runId"> = {
    tenantId: input.principal.tenantId, integrationId: input.principal.integrationId,
    sourceReviewRunId: input.sourceReviewRunId, findingId: input.findingId,
    platform: source.review.platform, repository: source.review.target.repository,
    baseSha: source.review.revision.baseSha, headSha: source.review.revision.headSha,
    sourceBundleRef, sourceBundleHash,
    allowedPaths: [source.finding.location.path], finding: { title: source.finding.title, body: source.finding.body,
      path: source.finding.location.path, startLine: source.finding.location.startLine, endLine: source.finding.location.endLine },
  };
  const runInput: FixRunInput = { schemaVersion: 1, workflow: "fix.propose.v1", policyId: policy.id, source: fixSource,
    original: { platform: source.review.platform, repository: source.review.target.repository,
      number: source.review.target.number, providerRepositoryId: source.review.target.providerRepositoryId,
      headBranch: source.review.presentation.headBranch, headSha: source.review.revision.headSha } };
  const creation = await buildFixRunCreationInput(input.binding, input.principal, createScope, createKey,
    requestHash, input.sourceReviewRunId, runInput, policy);
  const artifacts = new PgRunArtifactStore(input.db);
  const budgetAdmission = creation.admission;
  creation.admission = async (client, runId) => {
    await budgetAdmission?.(client, runId);
    const scope = { tenantId: input.principal.tenantId, integrationId: input.principal.integrationId, runId };
    await artifacts.putFixSnapshotForQueuedRunInTransaction(client, scope, snapshot.artifact);
    await artifacts.holdInTransaction(client, scope, sourceBundleHash, `fix-source:${runId}`, "fix");
  };
  const run = await input.db.transaction(input.principal.tenantId,
    (client) => createRunInTransaction(client, creation));
  return { id: run.id, status: run.status, version: run.version, created: run.created };
}

export async function buildFixRunCreationInput(
  binding: PublicationBinding,
  principal: RunPrincipal,
  createScope: string,
  createKey: string,
  requestHash: string,
  parentRunId: string,
  input: FixRunInput,
  fixPolicy: VerificationPolicy,
): Promise<CreateRunInput> {
  const { provider, model } = resolveModelConfiguration();
  const modelPolicy = getModelExecutionPolicy(provider, model);
  const baseManifest = await runtimeVersionManifest(modelPolicy);
  const manifest = { ...baseManifest,
    workflowVersionHash: fingerprint({ base: baseManifest.workflowVersionHash, workflow: "fix.propose.v1" }),
    promptVersionHash: fingerprint({ base: baseManifest.promptVersionHash, prompt: "fix.propose.v1" }),
    toolVersionHash: fingerprint({ base: baseManifest.toolVersionHash, snapshotSchema: 2 }),
    policyVersionHash: fingerprint({ base: baseManifest.policyVersionHash, fixPolicy }) };
  const maxRunMs = Math.max(15 * 60_000, fixPolicy.deadlineMs + 5 * 60_000);
  return { tenantId: binding.tenantId, integrationId: binding.id, actorType: principal.actorType, actorId: principal.subjectId,
    parentRunId, createScope, createKey, requestHash, runType: "fix.propose.v1",
    baseSha: input.source.baseSha, headSha: input.source.headSha, ...manifest, input: input as unknown as Record<string, unknown>,
    authorityGeneration: binding.generation, bindingAuthorityVersion: binding.version,
    executionModeGeneration: binding.executionModeGeneration ?? 0,
    runtimeConfig: { schemaVersion: 1, workflow: "fix.propose.v1", pollMs: 1_000, leaseTtlMs: 60_000,
      heartbeatMs: 15_000, sweepMs: 5_000, maxRunMs, maxJobAttempts: 3, maxStepAttempts: 3,
      maxCheckpointBytes: 4 * 1024 * 1024, modelPolicy, fixPolicy },
    limits: { maxRunMs, maxJobAttempts: 3, maxStepAttempts: 3, model: modelPolicy.runLimits },
    admission: (client, runId) => reserveRunBudgetInTransaction(client, { tenantId: binding.tenantId, runId, policy: modelPolicy }),
  };
}

async function loadAcceptedSource(db: RuntimeDatabase, principal: RunPrincipal, runId: string, findingId: string): Promise<{
  review: ReviewRunInput; finding: FindingCandidate;
}> {
  const selected = await db.transaction(principal.tenantId, (client) => client.query<{ input_json: unknown; record_json: unknown }>(
    `SELECT r.input_json,c.record_json FROM pr_agent_harness.agent_runs r
     JOIN pr_agent_harness.review_artifacts a ON a.tenant_id=r.tenant_id AND a.run_id=r.id AND a.content_purged_at IS NULL
     JOIN pr_agent_harness.finding_candidates c ON c.tenant_id=r.tenant_id AND c.run_id=r.id AND c.id=$4 AND c.content_purged_at IS NULL
     JOIN pr_agent_harness.finding_decisions d ON d.tenant_id=c.tenant_id AND d.run_id=c.run_id AND d.candidate_id=c.id
       AND d.stage='gate' AND d.content_purged_at IS NULL AND d.record_json->>'accepted'='true'
     WHERE r.tenant_id=$1 AND r.integration_id=$2 AND r.id=$3 AND r.run_type='review.deep.v1' AND r.status='succeeded'
       AND r.content_purged_at IS NULL`, [principal.tenantId, principal.integrationId, runId, findingId]));
  const row = selected.rows[0];
  if (!row) throw runNotFound();
  return { review: reviewRunInputSchema.parse(row.input_json), finding: findingSchema.parse(row.record_json) };
}

function resolveServerFixPolicy(): VerificationPolicy {
  const id = process.env.FIX_DEFAULT_POLICY_ID?.trim();
  if (!id) throw new Error("FIX_DEFAULT_POLICY_ID is required for FixRun admission");
  const policy = loadFixPolicyRegistry().get(id);
  if (!policy) throw new Error("Configured default FixRun policy was not found");
  return assertVerifierPolicy(policy);
}

async function repositoryAdapter(binding: PublicationBinding, headSha: string, credential: Promise<string>): Promise<{
  readFile(path: string): Promise<{ path: string; bytes: Uint8Array } | undefined>;
  listFiles(): Promise<string[]>;
}> {
  const token = await credential;
  if (binding.platform === "gitlab") return new GitLabRepositoryReadAdapter({ baseUrl: binding.origin, token,
    projectId: binding.providerRepositoryId, headSha });
  const [owner, repo, extra] = binding.repository.split("/");
  if (!owner || !repo || extra) throw new Error("GitHub repository must have owner/name form");
  return new GitHubRepositoryReadAdapter({ apiBaseUrl: binding.origin, token, owner, repo, headSha });
}

function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function snapshotPathAllowed(path: string): boolean {
  try { assertSafePath(path); } catch { return false; }
  return !/(^|\/)(?:node_modules|vendor|dist|build|coverage|generated)(?:\/|$)/i.test(path)
    && !/\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|7z|wasm|so|dll|dylib|exe|bin|map|min\.js)$/i.test(path);
}
