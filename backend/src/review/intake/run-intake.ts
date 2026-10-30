import { freezeDeepBudget } from "../deep/budget.js";
import type { PublicationBinding } from "../../agent-runtime/authority/publication-authority.js";
import { RunStore, type CreateRunInput } from "../../agent-runtime/postgres/run-store.js";
import { getModelExecutionPolicy, reserveRunBudgetInTransaction } from "../../agent-runtime/budget/model-budget-store.js";
import { resolveModelConfiguration } from "../../model/configuration.js";
import { getAgentRuntimeServices } from "../../agent-runtime/runtime/services.js";
import { currentRunExecutionContext } from "../../agent-runtime/execution/run-context.js";
import { reviewCreationRequestHash, reviewRunInputSchema, type ReviewRunInput } from "./run-input.js";
import { AGENT_RUNTIME_CONFIG, runtimeVersionManifest } from "../../agent-runtime/versions.js";
import { BASELINE_REVIEW_TEXT, withReviewTextVersions } from "../strategy/text-components.js";
import { recordDeepReleaseSelection, resolveDeepReleaseSelection } from "../../evolution/releases/selection.js";

export function shouldQueueReview(binding?: PublicationBinding): binding is PublicationBinding {
  if (!binding) throw new Error("Trusted PostgreSQL review execution binding is required");
  if (currentRunExecutionContext()) return false;
  if ((binding.reviewExecutionState ?? "active") !== "active") {
    throw new Error("Review execution is draining; new reviews are not admitted");
  }
  return true;
}

/** Called only after authenticated provider routing has resolved the trusted binding. */
export async function enqueueReviewRun(
  binding: PublicationBinding,
  input: ReviewRunInput,
  identity?: { actorType: "user" | "service"; actorId: string; parentRunId?: string },
): Promise<{ id: string; created: boolean }> {
  if ((binding.reviewExecutionState ?? "active") !== "active") {
    throw new Error("Active asynchronous review execution authority is required");
  }
  const creation = await buildReviewRunCreationInput(binding, input, identity);
  const services = await getAgentRuntimeServices();
  const result = await new RunStore(services.db).createRun(creation);
  return { id: result.id, created: result.created };
}

export async function buildReviewRunCreationInput(
  binding: PublicationBinding,
  input: ReviewRunInput,
  identity?: { actorType: "user" | "service"; actorId: string; parentRunId?: string },
): Promise<CreateRunInput> {
  const parsed = reviewRunInputSchema.parse(input);
  if (parsed.platform !== binding.platform || parsed.target.origin !== binding.origin
      || parsed.target.repository !== binding.repository || parsed.target.providerRepositoryId !== binding.providerRepositoryId) {
    throw new Error("Review intake target does not match its trusted integration");
  }
  const { provider, model } = resolveModelConfiguration();
  const policy = getModelExecutionPolicy(provider, model);
  const baseManifest = await runtimeVersionManifest(policy);
  const manifest = parsed.workflow === "review.deep.v1" ? withReviewTextVersions(baseManifest, BASELINE_REVIEW_TEXT) : baseManifest;
  const runtimeConfig = { ...AGENT_RUNTIME_CONFIG, modelPolicy: policy,
    ...(parsed.workflow === "review.deep.v1" ? { deepBudget: freezeDeepBudget(policy.runLimits), reviewText: BASELINE_REVIEW_TEXT } : {}) };
  return {
    tenantId: binding.tenantId, integrationId: binding.id,
    actorType: identity?.actorType ?? "service", actorId: identity?.actorId ?? `integration:${binding.id}`,
    parentRunId: identity?.parentRunId,
    createScope: `review.single.v1:${binding.id}`, createKey: parsed.source.key,
    // Configuration revisions do not turn a redelivered event into a new request.
    requestHash: reviewCreationRequestHash(parsed),
    runType: parsed.workflow, baseSha: parsed.revision.baseSha, headSha: parsed.revision.headSha,
    ...manifest, input: parsed, authorityGeneration: binding.generation,
    executionModeGeneration: binding.executionModeGeneration ?? 0,
    runtimeConfig,
    limits: { maxRunMs: AGENT_RUNTIME_CONFIG.maxRunMs, maxJobAttempts: AGENT_RUNTIME_CONFIG.maxJobAttempts,
      maxStepAttempts: AGENT_RUNTIME_CONFIG.maxStepAttempts, model: policy.runLimits },
    admission: (client, runId) => reserveRunBudgetInTransaction(client, { tenantId: binding.tenantId, runId, policy }),
    ...(parsed.workflow === "review.deep.v1" ? { prepareNewRun: async (client) => {
      const selected = await resolveDeepReleaseSelection(client, { binding, reviewInput: parsed, baseManifest });
      if (selected.manifest.runtimeVersionHash !== baseManifest.runtimeVersionHash
          || selected.manifest.workflowVersionHash !== baseManifest.workflowVersionHash
          || selected.manifest.modelVersionHash !== baseManifest.modelVersionHash
          || selected.manifest.policyVersionHash !== baseManifest.policyVersionHash) {
        throw new Error("Review text selection changed a fixed runtime component");
      }
      return { promptVersionHash: selected.manifest.promptVersionHash, toolVersionHash: selected.manifest.toolVersionHash,
        runtimeConfig: { ...runtimeConfig, reviewText: selected.reviewText, releaseSelection: selected.releaseSelection },
        admission: (transaction, runId) => recordDeepReleaseSelection(transaction, runId, selected.record) };
    } } : {}),
  };
}
