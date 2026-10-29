import { z } from "zod";

import type { PublicationBinding } from "../agent-runtime/authority/publication-authority.js";
import { PendingPublicationError, PublicationDefiniteFailureError } from "../agent-runtime/publication/publication.js";
import type { RunLease } from "../agent-runtime/runs/contracts.js";
import { currentRunExecutionContext } from "../agent-runtime/execution/run-context.js";
import { getAgentRuntimeServices, publicationRuntimeForBinding } from "../agent-runtime/runtime.js";
import { fingerprint } from "../agent-runtime/versions.js";
import { consumeFixApprovalInTransaction, FixStoreError } from "./fix-store.js";

const inputSchema = z.object({ workflow: z.literal("fix.publish.v1"), approvalId: z.string().uuid(),
  intentHash: z.string().regex(/^[a-f0-9]{64}$/), proposalRunId: z.string().uuid() }).passthrough();
const operationsSchema = z.array(z.object({
  operationType: z.enum(["fix_branch", "fix_commit", "fix_draft_pr"]),
  slot: z.enum(["fix.branch", "fix.commit", "fix.draft_pr"]), payload: z.record(z.unknown()),
}).strict()).min(2).max(3);

/** A distinct child Run consumes one immutable approval before any provider dispatch. */
export async function executeFixPublicationRun(lease: RunLease, binding: PublicationBinding): Promise<void> {
  const input = inputSchema.parse(lease.input);
  const context = currentRunExecutionContext();
  if (!context || context.lease.runId !== lease.runId || lease.tenantId !== binding.tenantId
      || lease.integrationId !== binding.id || lease.authorityGeneration !== binding.generation) {
    throw new FixStoreError("publish_run_scope_mismatch");
  }
  await context.assertActive();
  const services = await getAgentRuntimeServices();
  const intent = await services.db.transaction(lease.tenantId, async (client) => {
    const result = await client.query<{ intent_json: Record<string, unknown>; intent_hash: string }>(
      `SELECT intent_json,intent_hash FROM pr_agent_harness.fix_approval_requests
       WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 AND proposal_run_id=$4
         AND approved_publish_run_id=$5 AND status IN ('approved','consumed')`,
      [lease.tenantId,lease.integrationId,input.approvalId,input.proposalRunId,lease.runId]);
    const row = result.rows[0];
    if (!row || row.intent_hash !== input.intentHash || fingerprint(row.intent_json) !== input.intentHash) {
      throw new FixStoreError("approved_publish_intent_unavailable");
    }
    return row.intent_json;
  });
  const original = z.object({ platform: z.enum(["github","gitlab"]), repository: z.string(),
    number: z.number().int().positive(), headSha: z.string(), headBranch: z.string() }).strict().parse(intent.original);
  const operations = operationsSchema.parse(intent.operations);
  if (intent.headSha !== lease.headSha || intent.publishBaseSha !== lease.headSha
      || original.headSha !== lease.headSha || original.repository !== binding.repository
      || original.platform !== binding.platform || fingerprint(operations) !== intent.orderedOperationPlanHash) {
    throw new FixStoreError("approved_publish_plan_mismatch");
  }
  const runtime = await publicationRuntimeForBinding(binding,services);
  const batch = await runtime.batchStore.freeze({
    runLease: lease, scope: { ...runtime.scope, target: String(original.number), revision: lease.headSha },
    sourceKey: `fix.approval:${input.approvalId}`, sourceHash: input.intentHash, operations,
    authorize: async (client, frozen) => {
      const frozenPlan = frozen.operations.map(({ request }) => ({ operationType: request.operationType,
        slot: request.slot, payload: request.payload }));
      if (fingerprint(frozenPlan) !== intent.orderedOperationPlanHash) throw new FixStoreError("frozen_publish_plan_mismatch");
      const hash = await client.query<{ operation_set_hash: string }>(
        `SELECT operation_set_hash FROM pr_agent_harness.publication_batches
         WHERE tenant_id=$1 AND id=$2 AND seal_state='sealed'`, [lease.tenantId,frozen.id]);
      if (!hash.rows[0]?.operation_set_hash) throw new FixStoreError("publish_batch_not_sealed");
      await consumeFixApprovalInTransaction(client, { tenantId: lease.tenantId, approvalId: input.approvalId,
        publishRunId: lease.runId, batchId: frozen.id, operationSetHash: hash.rows[0].operation_set_hash,
        intentHash: input.intentHash });
    },
  });
  await context.assertActive();
  const completed = await runtime.batchCoordinator.execute(lease.tenantId,batch.id,runtime.createAdapter,lease);
  if (completed.status === "failed_definite") throw new PublicationDefiniteFailureError(batch.id,"fix_publication_failed");
  if (completed.status !== "succeeded") throw new PendingPublicationError(batch.id);
}
