import type { VerificationPolicy } from "../contracts.js";
import { fixRunInputSchema } from "../fix-input.js";
import { createFixWorkflowPolicy } from "../fix-policy.js";
import { PgFixStore } from "../fix-store.js";
import { executeFixProposal } from "../fix-workflow.js";
import { assertVerifierPolicy } from "../sandbox-policy.js";
import { readSnapshotBundle } from "../snapshot-bundle.js";
import { enqueueVerificationJob, waitForVerification } from "../verifier-jobs.js";
import { createStructuredModel } from "../../review/structured-model.js";
import type { PublicationBinding } from "../../agent-runtime/authority/publication-authority.js";
import { currentRunExecutionContext } from "../../agent-runtime/execution/run-context.js";
import type { RunLease } from "../../agent-runtime/runs/contracts.js";
import { getAgentRuntimeServices } from "../../agent-runtime/runtime.js";

export async function executeFixProposalRun(lease: RunLease, binding: PublicationBinding): Promise<void> {
  const context = currentRunExecutionContext();
  if (!context || context.lease.runId !== lease.runId) throw new Error("Fix proposal requires its durable Run context");
  const input = fixRunInputSchema.parse(lease.input);
  if (lease.tenantId !== binding.tenantId || lease.integrationId !== binding.id
      || input.source.tenantId !== lease.tenantId || input.source.integrationId !== lease.integrationId
      || input.source.platform !== binding.platform || input.source.repository !== binding.repository
      || input.source.baseSha !== lease.baseSha || input.source.headSha !== lease.headSha
      || lease.authorityGeneration !== binding.generation) {
    throw new Error("Durable fix binding or revision mismatch");
  }
  const fixPolicy = assertVerifierPolicy(lease.runtimeConfig.fixPolicy as VerificationPolicy);
  if (fixPolicy.id !== input.policyId || !lease.runtimeConfig.modelPolicy) {
    throw new Error("Frozen FixRun policy does not match its input");
  }
  const services = await getAgentRuntimeServices();
  const snapshot = await readSnapshotBundle({ root: snapshotRoot(), sourceBundleRef: input.source.sourceBundleRef,
    sourceBundleHash: input.source.sourceBundleHash });
  if (snapshot.manifest.headSha !== lease.headSha || snapshot.manifest.dependencyLockHash !== fixPolicy.dependencyLockHash) {
    throw new Error("FixRun snapshot identity mismatch");
  }
  const source = { ...input.source, runId: lease.runId };
  const store = new PgFixStore(services.db, enqueueVerificationJob);
  const artifact = await executeFixProposal(source, {
    lease, model: createStructuredModel(), store, signal: context.signal, step: context.step,
    readSourceFiles: async (paths) => paths.map((path) => {
      const content = snapshot.files.get(path);
      if (content === undefined) throw new Error("FixRun source path is absent from the frozen snapshot");
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

function snapshotRoot(): string { return process.env.FIX_VERIFIER_SNAPSHOT_ROOT?.trim() || "/var/lib/pr-agent-verifier/snapshots"; }
