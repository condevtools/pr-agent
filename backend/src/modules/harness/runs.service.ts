import { Injectable, type BeforeApplicationShutdown } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";

import { DeepReviewStore } from "../../review/deep/persistence/store.js";
import { RunApiAuthenticator } from "../../http/common/run-auth.js";
import { createReviewRequestSchema, resolveApiReviewInput, reviewApiSourceHash } from "../../http/runs/input.js";
import { requireRunPermission, runCommandSchema, runConflict, runNotFound, RunControlError, type RunPrincipal } from "../../agent-runtime/runs/control-contracts.js";
import { RunControlStore } from "../../agent-runtime/runs/control-store.js";
import { RunQueryStore } from "../../agent-runtime/runs/query-store.js";
import { RunEventStreamHub } from "../../http/runs/event-stream.js";
import { buildReviewRunCreationInput } from "../../review/intake/run-intake.js";
import { reviewCreationRequestHash, reviewRunInputSchema } from "../../review/intake/run-input.js";
import { getAgentRuntimeServices } from "../../agent-runtime/runtime.js";
import { RunStore } from "../../agent-runtime/postgres/run-store.js";
import { fingerprint, runtimeVersionManifest } from "../../agent-runtime/versions.js";
import { getModelExecutionPolicy } from "../../agent-runtime/budget/model-budget-store.js";
import { resolveModelConfiguration } from "../../review/ai-reviewer.js";
import type { PublicationBinding } from "../../agent-runtime/authority/publication-authority.js";
import type { FixArtifact } from "../../fix/contracts.js";
import { approveFixApprovalInTransaction, createApprovalInTransaction, PgFixStore, revokeApprovalInTransaction } from "../../fix/fix-store.js";
import { fixRunInputSchema } from "../../fix/fix-input.js";
import { buildFixPublicationPlan } from "../../fix/publication-plan.js";
import { readSnapshotBundle } from "../../fix/snapshot-bundle.js";
import { admitFixProposalRun } from "../../fix/proposal/intake.js";
import { createRunInTransaction } from "../../agent-runtime/postgres/run-store.js";
import { isFixDifferentialEligible } from "../../fix/verification-gate.js";

@Injectable()
export class RunsService implements BeforeApplicationShutdown {
  private readonly authenticator = new RunApiAuthenticator();
  private hub?: RunEventStreamHub;

  authenticate(request: Request): RunPrincipal {
    const headers = request.rawHeaders.filter((_value, index) => index % 2 === 0);
    if (headers.filter((name) => name.toLowerCase() === "authorization").length !== 1) {
      throw new RunControlError("UNAUTHORIZED", 401, "Exactly one bearer credential is required");
    }
    return this.authenticator.authenticate(request.headers.authorization);
  }

  async create(principal: RunPrincipal, key: unknown, body: unknown) {
    requireRunPermission(principal, "runs:create");
    const commandKey = z.string().min(1).max(200).parse(key);
    const request = createReviewRequestSchema.parse(body);
    const services = await getAgentRuntimeServices();
    const binding = await this.binding(principal);
    const source = { key: `api:${binding.id}:${commandKey}`, hash: reviewApiSourceHash(request) };
    const requestHash = reviewCreationRequestHash({ source, platform: binding.platform,
      target: { origin: binding.origin, repository: binding.repository, number: request.number,
        providerRepositoryId: binding.providerRepositoryId }, mode: request.mode, trigger: "comment-command" });
    const previous = await services.db.transaction(principal.tenantId, (client) => client.query<{
      id: string; status: string; version: string; request_hash: string;
    }>(
      `SELECT id,status,version,request_hash
       FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND integration_id=$2 AND create_scope=$3 AND create_key=$4`,
      [principal.tenantId, principal.integrationId, `review.single.v1:${binding.id}`, source.key],
    ));
    if (previous.rows[0]) {
      if (previous.rows[0].request_hash !== requestHash) throw runConflict("Idempotency key was used for a different review request");
      return { id: previous.rows[0].id, status: previous.rows[0].status, version: Number(previous.rows[0].version), created: false };
    }
    if (binding.reviewExecutionMode !== "harness_async" || binding.state !== "active") {
      throw runConflict("Asynchronous review admission is not active for this integration");
    }
    const input = await resolveApiReviewInput(binding, request, source);
    const creation = await buildReviewRunCreationInput(binding, input, { actorType: principal.actorType, actorId: principal.subjectId });
    const run = await new RunStore(services.db).createRun(creation);
    return { id: run.id, status: run.status, version: run.version, created: run.created };
  }

  async snapshot(principal: RunPrincipal, runId: string) {
    requireRunPermission(principal, "runs:read");
    return (await this.queries()).snapshot(principal, validRunId(runId));
  }
  async events(principal: RunPrincipal, runId: string, after?: string, limit?: string) {
    requireRunPermission(principal, "runs:read");
    const count = limit === undefined ? 100 : z.coerce.number().int().min(1).max(200).parse(limit);
    return (await this.queries()).events(principal, validRunId(runId), z.string().max(256).optional().parse(after), count);
  }
  async trace(principal: RunPrincipal, runId: string, after?: string) {
    requireRunPermission(principal, "runs:trace");
    return (await this.queries()).trace(principal, validRunId(runId), z.string().max(1024).optional().parse(after));
  }

  async artifact(principal: RunPrincipal, runId: string, raw?: string) {
    requireRunPermission(principal, "runs:read");
    const includeRaw = z.enum(["true", "false"]).optional().parse(raw) === "true";
    const id = validRunId(runId);
    const services = await getAgentRuntimeServices();
    const type = await services.db.transaction(principal.tenantId, (client) => client.query<{ run_type: string }>(
      `SELECT run_type FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND integration_id=$2 AND id=$3`,
      [principal.tenantId, principal.integrationId, id]));
    if (!type.rows[0]) throw runNotFound();
    return type.rows[0].run_type === "fix.propose.v1"
      ? new PgFixStore(services.db).readArtifact(principal, id, { raw: includeRaw })
      : new DeepReviewStore(services.db).readArtifact(principal, id, { raw: includeRaw });
  }

  async createFix(principal: RunPrincipal, sourceReviewRunId: string, key: unknown, body: unknown) {
    requireRunPermission(principal, "fixes:create");
    const commandKey = z.string().min(1).max(200).parse(key);
    const request = z.object({ findingId: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(body);
    const services = await getAgentRuntimeServices();
    const binding = await this.binding(principal);
    if (binding.reviewExecutionMode !== "harness_async" || binding.state !== "active") {
      throw runConflict("Asynchronous fix admission is not active for this integration");
    }
    const run = await admitFixProposalRun({ db: services.db, binding, principal,
      sourceReviewRunId: validRunId(sourceReviewRunId), commandKey, findingId: request.findingId });
    return { ...run, links: { self: `/runs/${run.id}`, artifact: `/runs/${run.id}/artifact` } };
  }

  async createFixApproval(principal: RunPrincipal, proposalRunId: string, key: unknown, body: unknown) {
    requireRunPermission(principal, "fixes:create");
    z.object({}).strict().parse(body);
    const commandKey = z.string().min(1).max(200).parse(key);
    const id = validRunId(proposalRunId);
    const services = await getAgentRuntimeServices();
    const material = await this.fixApprovalMaterial(principal, id);
    if (material.input.original.platform === "gitlab") {
      throw runConflict("GitLab fix publication is suggestion-only because conditional branch creation is unsupported");
    }
    await assertFixHeadCurrent(await this.binding(principal), material.input.original);
    const snapshot = await readSnapshotBundle({ root: fixSnapshotRoot(),
      sourceBundleRef: material.artifact.proposal!.sourceBundleRef,
      sourceBundleHash: material.artifact.proposal!.sourceBundleHash });
    const plan = buildFixPublicationPlan(material.artifact.proposal!, material.input.original,
      snapshot.files, material.artifact.verification!, material.relevance);
    const receipt = await services.db.transaction(principal.tenantId, (client) => createApprovalInTransaction(client, {
      tenantId: principal.tenantId, integrationId: principal.integrationId, proposalRunId: id,
      proposalId: material.artifact.proposal!.id, commandKey, intent: plan.intent,
      maker: { type: principal.actorType, id: principal.subjectId }, ttlSeconds: fixApprovalTtlSeconds(),
    }));
    return { ...receipt, preview: { proposalId: material.artifact.proposal!.id,
      proposalHash: material.artifact.proposal!.proposalHash, branchName: plan.branchName,
      branchNameHash: plan.branchNameHash, publishBaseSha: plan.publishBaseSha,
      orderedOperationPlanHash: plan.orderedOperationPlanHash,
      operations: plan.operations.map(({ operationType, slot }) => ({ operationType, slot })) } };
  }

  async attestFixRelevance(principal: RunPrincipal, proposalRunId: string, body: unknown) {
    requireRunPermission(principal, "fixes:approve");
    const runId = validRunId(proposalRunId);
    const request = fixRelevanceSchema.parse(body);
    return new PgFixStore((await getAgentRuntimeServices()).db).attestRelevance({
      tenantId: principal.tenantId, integrationId: principal.integrationId, proposalRunId: runId,
      ...request, actor: { type: principal.actorType, id: principal.subjectId },
    });
  }

  async approveFix(principal: RunPrincipal, proposalRunId: string, approvalId: string, body: unknown) {
    requireRunPermission(principal, "fixes:approve");
    const runId = validRunId(proposalRunId); const approval = validRunId(approvalId);
    const request = fixApprovalDecisionSchema.parse(body);
    const services = await getAgentRuntimeServices();
    const material = await this.fixApprovalMaterial(principal, runId);
    await assertFixHeadCurrent(await this.binding(principal), material.input.original);
    const { provider, model } = resolveModelConfiguration();
    const currentRuntimeHash = (await runtimeVersionManifest(getModelExecutionPolicy(provider,model))).runtimeVersionHash;
    return services.db.transaction(principal.tenantId, async (client) => {
      await assertApprovalIntent(client, principal, runId, approval, request.intentHash);
      return approveFixApprovalInTransaction(client, {
        tenantId: principal.tenantId, integrationId: principal.integrationId, approvalId: approval,
        commandKey: request.commandKey,
        requestHash: fingerprint({ approvalId: approval, command: "approve", ...request }),
        expectedVersion: request.expectedVersion, actor: { type: principal.actorType, id: principal.subjectId },
      }, async (transaction, exact) => {
        const parent = await transaction.query<ParentFixRunRow>(
          `SELECT base_sha,head_sha,workflow_version_hash,prompt_version_hash,model_version_hash,tool_version_hash,
                  policy_version_hash,runtime_version_hash,authority_generation,execution_mode_generation,
                  runtime_config_json,limits_json
           FROM pr_agent_harness.agent_runs WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 FOR SHARE`,
          [principal.tenantId, principal.integrationId, exact.proposalRunId]);
        const row = parent.rows[0]; if (!row) throw runNotFound();
        if (row.runtime_version_hash !== currentRuntimeHash) {
          throw runConflict("Fix proposal runtime changed; create a new proposal before approving publication");
        }
        const created = await createRunInTransaction(transaction, {
          tenantId: principal.tenantId, integrationId: principal.integrationId,
          actorType: principal.actorType, actorId: principal.subjectId, parentRunId: exact.proposalRunId,
          createScope: `fix.publish.v1:${principal.integrationId}`, createKey: `approval:${exact.approvalId}`,
          requestHash: exact.intentHash, runType: "fix.publish.v1", baseSha: row.base_sha, headSha: row.head_sha,
          workflowVersionHash: fingerprint({ base: row.workflow_version_hash,workflow: "fix.publish.v1" }), promptVersionHash: row.prompt_version_hash,
          modelVersionHash: row.model_version_hash, toolVersionHash: row.tool_version_hash,
          policyVersionHash: row.policy_version_hash, runtimeVersionHash: row.runtime_version_hash,
          input: { schemaVersion: 1, workflow: "fix.publish.v1", approvalId: exact.approvalId,
            intentHash: exact.intentHash, proposalRunId: exact.proposalRunId },
          authorityGeneration: Number(row.authority_generation), executionModeGeneration: Number(row.execution_mode_generation),
          runtimeConfig: publishRuntimeConfig(row.runtime_config_json), limits: publishLimits(row.limits_json),
        });
        return created.id;
      });
    });
  }

  async revokeFix(principal: RunPrincipal, proposalRunId: string, approvalId: string, body: unknown) {
    requireRunPermission(principal, "fixes:revoke");
    const runId = validRunId(proposalRunId); const approval = validRunId(approvalId);
    const request = fixApprovalDecisionSchema.parse(body);
    const services = await getAgentRuntimeServices(); await this.binding(principal);
    return services.db.transaction(principal.tenantId, async (client) => {
      await assertApprovalIntent(client, principal, runId, approval, request.intentHash);
      return revokeApprovalInTransaction(client, { tenantId: principal.tenantId,
        integrationId: principal.integrationId, approvalId: approval, commandKey: request.commandKey,
        requestHash: fingerprint({ approvalId: approval, command: "revoke", ...request }),
        expectedVersion: request.expectedVersion, actor: { type: principal.actorType, id: principal.subjectId } });
    });
  }

  async command(principal: RunPrincipal, runId: string, kind: string, body: unknown) {
    validRunId(runId);
    const fields = z.record(z.unknown()).parse(body);
    if ("kind" in fields) throw new RunControlError("INVALID_REQUEST", 422, "Command kind is selected by the route");
    const command = runCommandSchema.parse({ ...fields, kind });
    requireRunPermission(principal, `runs:${command.kind}`);
    const services = await getAgentRuntimeServices();
    const store = new RunControlStore(services.db);
    if (command.kind !== "rerun") return store.apply(principal, runId, command);
    const previous = await store.lookupReceipt(principal, runId, command);
    if (previous) return previous;
    const original = reviewRunInputSchema.parse(await (await this.queries()).originalInput(principal, runId));
    const binding = await this.binding(principal);
    const source = { key: `rerun:${runId}:${command.commandKey}`, hash: fingerprint({ parentRunId: runId, command }) };
    const creation = await buildReviewRunCreationInput(binding, { ...original, source },
      { actorType: principal.actorType, actorId: principal.subjectId, parentRunId: runId });
    return store.apply(principal, runId, command, creation);
  }

  async stream(principal: RunPrincipal, runId: string, after: string | undefined, response: Response): Promise<void> {
    requireRunPermission(principal, "runs:read");
    validRunId(runId);
    const queries = await this.queries();
    this.hub ??= new RunEventStreamHub(queries);
    await this.hub.open(principal, runId, z.string().max(256).optional().parse(after), response);
  }

  async beforeApplicationShutdown(): Promise<void> { await this.hub?.stop(); }
  private async queries(): Promise<RunQueryStore> { return new RunQueryStore((await getAgentRuntimeServices()).db); }
  private async binding(principal: RunPrincipal) {
    const services = await getAgentRuntimeServices();
    const authorized = await services.db.transaction(principal.tenantId, (client) => client.query(
      "SELECT 1 FROM pr_agent_harness.integration_bindings WHERE tenant_id=$1 AND id=$2 AND active",
      [principal.tenantId, principal.integrationId],
    ));
    if (!authorized.rowCount) throw runNotFound();
    return services.authority.get(principal.tenantId, principal.integrationId);
  }

  private async fixApprovalMaterial(principal: RunPrincipal, runId: string): Promise<{
    input: z.infer<typeof fixRunInputSchema>; artifact: FixArtifact;
    relevance: { kind: "human"; testPatchHash: string; attestationHash: string };
  }> {
    const services = await getAgentRuntimeServices();
    const selected = await services.db.transaction(principal.tenantId, (client) => client.query<{
      input_json: unknown; artifact_json: FixArtifact; content_hash: string;
      relevance_test_patch_hash: string; relevance_attestation_hash: string;
    }>(`SELECT r.input_json,a.artifact_json,a.content_hash,
               fra.test_patch_hash AS relevance_test_patch_hash,fra.attestation_hash AS relevance_attestation_hash
        FROM pr_agent_harness.agent_runs r
        JOIN pr_agent_harness.fix_artifacts a ON a.tenant_id=r.tenant_id AND a.integration_id=r.integration_id AND a.run_id=r.id
        JOIN pr_agent_harness.fix_relevance_attestations fra ON fra.tenant_id=r.tenant_id AND fra.integration_id=r.integration_id
          AND fra.proposal_run_id=r.id
        WHERE r.tenant_id=$1 AND r.integration_id=$2 AND r.id=$3 AND r.run_type='fix.propose.v1'
          AND r.status='succeeded' AND r.content_purged_at IS NULL AND a.content_purged_at IS NULL`,
    [principal.tenantId, principal.integrationId, runId]));
    const row = selected.rows[0];
    if (!row || fingerprint(row.artifact_json) !== row.content_hash || !row.artifact_json.proposal
        || !row.artifact_json.verification || row.artifact_json.proposal.qualificationStatus !== "verified"
        || !isFixDifferentialEligible(row.artifact_json.verification)) {
      throw runConflict("Fix proposal is not approval-ready");
    }
    if (row.relevance_test_patch_hash !== row.artifact_json.proposal.testPatchHash) {
      throw runConflict("Human relevance attestation does not match the approved test patch");
    }
    return { input: fixRunInputSchema.parse(row.input_json), artifact: row.artifact_json,
      relevance: { kind: "human", testPatchHash: row.relevance_test_patch_hash,
        attestationHash: row.relevance_attestation_hash } };
  }
}

function validRunId(value: string): string { return z.string().uuid().parse(value); }

const fixApprovalDecisionSchema = z.object({ commandKey: z.string().min(1).max(200),
  intentHash: z.string().regex(/^[a-f0-9]{64}$/), expectedVersion: z.number().int().positive() }).strict();
const fixRelevanceSchema = z.object({ commandKey: z.string().min(1).max(200), proposalId: z.string().regex(/^[a-f0-9]{64}$/),
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/), testPatchHash: z.string().regex(/^[a-f0-9]{64}$/),
  findingId: z.string().regex(/^[a-f0-9]{64}$/), verificationResultHash: z.string().regex(/^[a-f0-9]{64}$/),
  rubricVersion: z.string().min(1).max(128), reason: z.string().min(20).max(4000) }).strict();

interface ParentFixRunRow {
  base_sha: string; head_sha: string; workflow_version_hash: string; prompt_version_hash: string;
  model_version_hash: string; tool_version_hash: string; policy_version_hash: string; runtime_version_hash: string;
  authority_generation: string; execution_mode_generation: string;
  runtime_config_json: Record<string, unknown>; limits_json: Record<string, unknown>;
}

async function assertApprovalIntent(client: import("pg").PoolClient, principal: RunPrincipal,
  proposalRunId: string, approvalId: string, intentHash: string): Promise<void> {
  const selected = await client.query<{ intent_hash: string }>(
    `SELECT intent_hash FROM pr_agent_harness.fix_approval_requests
     WHERE tenant_id=$1 AND integration_id=$2 AND proposal_run_id=$3 AND id=$4`,
    [principal.tenantId, principal.integrationId, proposalRunId, approvalId]);
  if (!selected.rows[0]) throw runNotFound();
  if (selected.rows[0].intent_hash !== intentHash) throw runConflict("Approval intent hash does not match the frozen preview");
}

function publishRuntimeConfig(value: Record<string, unknown>): Record<string, unknown> {
  return { schemaVersion: 1, workflow: "fix.publish.v1", pollMs: value.pollMs ?? 1_000,
    leaseTtlMs: value.leaseTtlMs ?? 60_000, heartbeatMs: value.heartbeatMs ?? 15_000,
    sweepMs: value.sweepMs ?? 5_000, maxRunMs: value.maxRunMs ?? 15 * 60_000,
    maxJobAttempts: value.maxJobAttempts ?? 3, maxStepAttempts: value.maxStepAttempts ?? 3,
    maxCheckpointBytes: value.maxCheckpointBytes ?? 4 * 1024 * 1024 };
}
function publishLimits(value: Record<string, unknown>): Record<string, unknown> {
  return { maxRunMs: value.maxRunMs ?? 15 * 60_000, maxJobAttempts: value.maxJobAttempts ?? 3,
    maxStepAttempts: value.maxStepAttempts ?? 3 };
}
function fixSnapshotRoot(): string { return process.env.FIX_VERIFIER_SNAPSHOT_ROOT?.trim() || "/var/lib/pr-agent-verifier/snapshots"; }
function fixApprovalTtlSeconds(): number {
  const value = Number(process.env.FIX_APPROVAL_TTL_SECONDS ?? "86400");
  if (!Number.isSafeInteger(value) || value < 300 || value > 86400) throw new Error("FIX_APPROVAL_TTL_SECONDS must be 300-86400");
  return value;
}

async function assertFixHeadCurrent(binding: PublicationBinding,
  original: z.infer<typeof fixRunInputSchema>["original"]): Promise<void> {
  const current = await resolveApiReviewInput(binding, { workflow: "review.deep.v1", number: original.number,
    mode: "report", options: { customRules: [], includeCiChecks: false, enableSecretScan: true,
      secretScanCustomPatterns: [], enableAutoLabel: false } },
  { key: `fix-approval-head:${original.number}`, hash: fingerprint(original) });
  if (current.target.repository !== original.repository || current.revision.headSha !== original.headSha
      || current.presentation.headBranch !== original.headBranch) {
    throw runConflict("Pull request head moved after the fix proposal was created");
  }
}
