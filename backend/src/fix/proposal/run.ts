import type { VerificationPolicy } from "../contracts.js";
import { fixRunInputSchema } from "./input.js";
import { createFixWorkflowPolicy } from "./policy.js";
import { PgFixStore } from "../persistence/store.js";
import { executeFixProposal } from "./workflow.js";
import { assertVerifierPolicy } from "../verification/sandbox-policy.js";
import { FIX_SNAPSHOT_CONTENT_TYPE, readSnapshotBundleContent } from "../persistence/snapshot-bundle.js";
import { enqueueVerificationJob, waitForVerification } from "../verification/jobs.js";
import { createStructuredModel } from "../../model/structured-model.js";
import type { PublicationBinding } from "../../agent-runtime/authority/publication-authority.js";
import { currentRunExecutionContext } from "../../agent-runtime/execution/run-context.js";
import { RunExecutionContractError, type RunLease } from "../../agent-runtime/runs/contracts.js";
import { getAgentRuntimeServices } from "../../agent-runtime/runtime/services.js";
import { PgRunArtifactStore } from "../../agent-runtime/artifacts/index.js";

export async function executeFixProposalRun(lease: RunLease, binding: PublicationBinding): Promise<void> {
  const context = currentRunExecutionContext();
  if (!context || context.lease.runId !== lease.runId) {
    throw new RunExecutionContractError("Fix proposal requires its durable Run context");
  }
  const input = fixRunInputSchema.parse(lease.input);
  if (lease.tenantId !== binding.tenantId || lease.integrationId !== binding.id
      || input.source.tenantId !== lease.tenantId || input.source.integrationId !== lease.integrationId
      || input.source.platform !== binding.platform || input.source.repository !== binding.repository
      || input.source.baseSha !== lease.baseSha || input.source.headSha !== lease.headSha
      || lease.authorityGeneration !== binding.generation) {
    throw new RunExecutionContractError("Durable fix binding or revision mismatch");
  }
  const fixPolicy = assertVerifierPolicy(lease.runtimeConfig.fixPolicy as VerificationPolicy);
  if (fixPolicy.id !== input.policyId || !lease.runtimeConfig.modelPolicy) {
    throw new RunExecutionContractError("Frozen FixRun policy does not match its input");
  }
  const services = await getAgentRuntimeServices();
  const stored = await new PgRunArtifactStore(services.db).read({ tenantId: lease.tenantId,
    integrationId: lease.integrationId, runId: lease.runId }, input.source.sourceBundleHash);
  if (!stored || stored.status !== "available" || stored.ref.purpose !== "fix_snapshot"
      || stored.ref.contentType !== FIX_SNAPSHOT_CONTENT_TYPE) {
    throw new RunExecutionContractError("FixRun source snapshot artifact is unavailable");
  }
  const snapshot = readSnapshotBundleContent({ content: stored.content,
    sourceBundleRef: input.source.sourceBundleRef, sourceBundleHash: input.source.sourceBundleHash });
  if (snapshot.manifest.headSha !== lease.headSha || snapshot.manifest.dependencyLockHash !== fixPolicy.dependencyLockHash) {
    throw new RunExecutionContractError("FixRun snapshot identity mismatch");
  }
  const source = { ...input.source, runId: lease.runId };
  const store = new PgFixStore(services.db, enqueueVerificationJob);
  const artifact = await executeFixProposal(source, {
    lease, model: createStructuredModel(), store, signal: context.signal, step: context.step,
    readSourceFiles: async (paths) => paths.map((path) => {
      const content = snapshot.files.get(path);
      if (content === undefined) {
        throw new RunExecutionContractError("FixRun source path is absent from the frozen snapshot");
      }
      return { path, content };
    }),
    waitForVerification: (proposal) => waitForVerification(services.db, lease, proposal, context.signal),
  }, createFixWorkflowPolicy(fixPolicy));
  if (artifact.outcome === "failed") throw new FixProposalFailedError(artifact.reasonCodes);
}

export class FixProposalFailedError extends Error {
  constructor(readonly reasonCodes: readonly string[]) {
    super("Fix proposal could not produce a valid bounded patch"); this.name = "FixProposalFailedError";
  }
}
