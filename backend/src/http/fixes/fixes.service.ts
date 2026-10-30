import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";

import { getModelExecutionPolicy } from "../../agent-runtime/budget/model-budget-store.js";
import type { PublicationBinding } from "../../agent-runtime/authority/publication-authority.js";
import { requireRunPermission, runConflict, runNotFound, type RunPrincipal } from "../../agent-runtime/runs/control-contracts.js";
import { createRunInTransaction } from "../../agent-runtime/postgres/run-store.js";
import { getAgentRuntimeServices } from "../../agent-runtime/runtime/services.js";
import { fingerprint, runtimeVersionManifest } from "../../agent-runtime/versions.js";
import { approveFixApprovalInTransaction, createApprovalInTransaction, PgFixApprovalStore, revokeApprovalInTransaction } from "../../fix/approval/store.js";
import type { FixArtifact } from "../../fix/contracts.js";
import { FIX_SNAPSHOT_CONTENT_TYPE, readSnapshotBundleContent } from "../../fix/persistence/snapshot-bundle.js";
import { PgRunArtifactStore } from "../../agent-runtime/artifacts/index.js";
import { buildFixPublicationPlan } from "../../fix/publication/plan.js";
import { admitFixProposalRun } from "../../fix/proposal/intake.js";
import { fixRunInputSchema } from "../../fix/proposal/input.js";
import { isFixDifferentialEligible } from "../../fix/verification/gate.js";
import { resolveModelConfiguration } from "../../model/configuration.js";
import { resolveReviewInput } from "../../review/intake/resolve-input.js";
import { RunApiContextService, validRunId } from "../common/run-api-context.service.js";

@Injectable()
export class FixesService {
  constructor(@Inject(RunApiContextService) private readonly context: RunApiContextService) {}

  async createFix(principal: RunPrincipal, sourceReviewRunId: string, key: unknown, body: unknown) {
    requireRunPermission(principal, "fixes:create");
    const commandKey = z.string().min(1).max(200).parse(key);
    const request = z.object({ findingId: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(body);
    const services = await getAgentRuntimeServices();
    const binding = await this.context.binding(principal);
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
    await assertFixHeadCurrent(await this.context.binding(principal), material.input.original);
    const proposal = material.artifact.proposal!;
    const stored = await new PgRunArtifactStore(services.db).read({ tenantId: principal.tenantId,
      integrationId: principal.integrationId, runId: id }, proposal.sourceBundleHash);
    if (!stored || stored.status !== "available" || stored.ref.purpose !== "fix_snapshot"
        || stored.ref.contentType !== FIX_SNAPSHOT_CONTENT_TYPE) throw runConflict("Fix source snapshot artifact is unavailable");
    const snapshot = readSnapshotBundleContent({ content: stored.content,
      sourceBundleRef: proposal.sourceBundleRef, sourceBundleHash: proposal.sourceBundleHash });
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
    return new PgFixApprovalStore((await getAgentRuntimeServices()).db).attestRelevance({
      tenantId: principal.tenantId, integrationId: principal.integrationId, proposalRunId: runId,
      ...request, actor: { type: principal.actorType, id: principal.subjectId },
    });
  }

  async approveFix(principal: RunPrincipal, proposalRunId: string, approvalId: string, body: unknown) {
    requireRunPermission(principal, "fixes:approve");
    const runId = validRunId(proposalRunId); const approval = validRunId(approvalId);
    const request = fixApprovalDecisionSchema.parse(body);
    const services = await getAgentRuntimeServices();
    const binding = await this.context.binding(principal);
    const material = await this.fixApprovalMaterial(principal, runId);
    await assertFixHeadCurrent(await this.context.binding(principal), material.input.original);
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
          authorityGeneration: Number(row.authority_generation), bindingAuthorityVersion: binding.version,
          executionModeGeneration: Number(row.execution_mode_generation),
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
    const services = await getAgentRuntimeServices();
    return services.db.transaction(principal.tenantId, async (client) => {
      await assertApprovalIntent(client, principal, runId, approval, request.intentHash);
      return revokeApprovalInTransaction(client, { tenantId: principal.tenantId,
        integrationId: principal.integrationId, approvalId: approval, commandKey: request.commandKey,
        requestHash: fingerprint({ approvalId: approval, command: "revoke", ...request }),
        expectedVersion: request.expectedVersion, actor: { type: principal.actorType, id: principal.subjectId } });
    });
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
function fixApprovalTtlSeconds(): number {
  const value = Number(process.env.FIX_APPROVAL_TTL_SECONDS ?? "86400");
  if (!Number.isSafeInteger(value) || value < 300 || value > 86400) throw new Error("FIX_APPROVAL_TTL_SECONDS must be 300-86400");
  return value;
}

async function assertFixHeadCurrent(binding: PublicationBinding,
  original: z.infer<typeof fixRunInputSchema>["original"]): Promise<void> {
  const current = await resolveReviewInput(binding, { workflow: "review.deep.v1", number: original.number,
    mode: "report", options: { customRules: [], includeCiChecks: false, enableSecretScan: true,
      secretScanCustomPatterns: [], enableAutoLabel: false } },
  { key: `fix-approval-head:${original.number}`, hash: fingerprint(original) });
  if (current.target.repository !== original.repository || current.revision.headSha !== original.headSha
      || current.presentation.headBranch !== original.headBranch) {
    throw runConflict("Pull request head moved after the fix proposal was created");
  }
}
