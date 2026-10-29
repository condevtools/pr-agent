import type { PublicationBinding } from "./authority.js";
import { HarnessRunStore, type CreateRunInput } from "./postgres/run-store.js";
import { getModelExecutionPolicy, reserveRunBudgetInTransaction } from "./model-budget-store.js";
import { resolveReviewModelConfiguration } from "../review/ai-reviewer.js";
import { getHarnessServices } from "./runtime.js";
import { currentReviewRunContext } from "./review-run-context.js";
import { reviewRunInputSchema, type ReviewRunInput } from "./review-run-input.js";
import { fingerprint, REVIEW_RUNTIME_CONFIG, reviewVersionManifest } from "./versions.js";

export function shouldQueueReview(binding?: PublicationBinding): binding is PublicationBinding {
  return Boolean(binding?.reviewExecutionMode === "harness_async" && !currentReviewRunContext());
}

/** Called only after authenticated provider routing has resolved the trusted binding. */
export async function enqueueReviewRun(binding: PublicationBinding, input: ReviewRunInput): Promise<{ id: string; created: boolean }> {
  const creation = await buildReviewRunCreationInput(binding, input);
  const services = await getHarnessServices();
  const result = await new HarnessRunStore(services.db).createRun(creation);
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
  const { provider, model } = resolveReviewModelConfiguration();
  const policy = getModelExecutionPolicy(provider, model);
  const manifest = await reviewVersionManifest(policy);
  return {
    tenantId: binding.tenantId, integrationId: binding.id,
    actorType: identity?.actorType ?? "service", actorId: identity?.actorId ?? `integration:${binding.id}`,
    parentRunId: identity?.parentRunId,
    createScope: `review.single.v1:${binding.id}`, createKey: parsed.source.key,
    // Configuration revisions do not turn a redelivered event into a new request.
    requestHash: fingerprint({ source: parsed.source, platform: parsed.platform, target: parsed.target, mode: parsed.mode, trigger: parsed.trigger }),
    runType: parsed.workflow, baseSha: parsed.revision.baseSha, headSha: parsed.revision.headSha,
    ...manifest, input: parsed, authorityGeneration: binding.generation,
    executionModeGeneration: binding.executionModeGeneration ?? 0,
    runtimeConfig: { ...REVIEW_RUNTIME_CONFIG, modelPolicy: policy },
    limits: { maxRunMs: REVIEW_RUNTIME_CONFIG.maxRunMs, maxJobAttempts: REVIEW_RUNTIME_CONFIG.maxJobAttempts,
      maxStepAttempts: REVIEW_RUNTIME_CONFIG.maxStepAttempts, model: policy.runLimits },
    admission: (client, runId) => reserveRunBudgetInTransaction(client, { tenantId: binding.tenantId, runId, policy }),
  };
}
