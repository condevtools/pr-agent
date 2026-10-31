import { freezeDeepBudget } from "../deep/budget.js";
import type { PublicationBinding } from "../../agent-runtime/authority/publication-authority.js";
import { RunStore, type CreateRunInput } from "../../agent-runtime/postgres/run-store.js";
import { getModelExecutionPolicy, reserveRunBudgetInTransaction } from "../../agent-runtime/budget/model-budget-store.js";
import { resolveModelConfiguration } from "../../model/configuration.js";
import { getAgentRuntimeServices } from "../../agent-runtime/runtime/services.js";
import { reviewCreationRequestHash, reviewRunInputSchema, type ReviewRunInput } from "./run-input.js";
import { AGENT_RUNTIME_CONFIG, runtimeVersionManifest } from "../../agent-runtime/versions.js";
import { BASELINE_REVIEW_TEXT, withReviewTextVersions } from "../strategy/text-components.js";
import { recordDeepReleaseSelection, resolveBaselineDeepReleaseSelection,
  resolveDeepReleaseSelection } from "../../evolution/releases/selection.js";
import { bindingAllowsCapability } from "../../agent-runtime/runtime/capabilities.js";
import {
  createOrReuseGitHubDeliveryRun,
  GitHubDeliveryHandoffError,
  type GitHubDeferredRunHandoff,
  type GitHubDeliveryIdentity,
} from "./github-delivery-handoff.js";

export type { GitHubDeferredRunHandoff } from "./github-delivery-handoff.js";

/** Called only after authenticated provider routing has resolved the trusted binding. */
export async function enqueueReviewRun(
  binding: PublicationBinding,
  input: ReviewRunInput,
  identity?: { actorType: "user" | "service"; actorId: string; parentRunId?: string },
  deferredHandoff?: GitHubDeferredRunHandoff,
): Promise<{ id: string; created: boolean }> {
  if ((binding.reviewExecutionState ?? "active") !== "active") {
    throw new Error("Active asynchronous review execution authority is required");
  }
  const parsed = parseTrustedReviewInput(binding, input);
  const services = await getAgentRuntimeServices();
  const delivery = githubDeliveryIdentity(binding, parsed);
  if (deferredHandoff && !delivery) {
    throw new Error("Deferred GitHub handoff requires a stable GitHub delivery identity");
  }
  if (delivery) {
    const result = await services.db.transaction(binding.tenantId, async (client) => {
      try {
        return await createOrReuseGitHubDeliveryRun(client, delivery,
          async () => await buildParsedReviewRunCreationInput(binding, parsed, identity), deferredHandoff);
      } catch (error) {
        // These statuses are returned by SQL after recording integrity evidence.
        // Commit that evidence before surfacing a denial; creation/lease failures still roll back.
        if (error instanceof GitHubDeliveryHandoffError && error.code !== "deferred_claim_stale") return error;
        throw error;
      }
    });
    if (result instanceof GitHubDeliveryHandoffError) throw result;
    return result;
  }
  const creation = await buildParsedReviewRunCreationInput(binding, parsed, identity);
  const result = await new RunStore(services.db).createRun(creation);
  return { id: result.id, created: result.created };
}

export async function buildReviewRunCreationInput(
  binding: PublicationBinding,
  input: ReviewRunInput,
  identity?: { actorType: "user" | "service"; actorId: string; parentRunId?: string },
): Promise<CreateRunInput> {
  return await buildParsedReviewRunCreationInput(binding, parseTrustedReviewInput(binding, input), identity);
}

async function buildParsedReviewRunCreationInput(
  binding: PublicationBinding,
  parsed: ReviewRunInput,
  identity?: { actorType: "user" | "service"; actorId: string; parentRunId?: string },
): Promise<CreateRunInput> {
  const delivery = githubDeliveryIdentity(binding, parsed);
  const creation = {
    tenantId: binding.tenantId, integrationId: binding.id,
    actorType: identity?.actorType ?? "service", actorId: identity?.actorId ?? `integration:${binding.id}`,
    parentRunId: identity?.parentRunId,
    createScope: `${parsed.workflow}:${binding.id}`, createKey: parsed.source.key,
    // Configuration revisions do not turn a redelivered event into a new request.
    requestHash: reviewCreationRequestHash(parsed),
    runType: parsed.workflow, baseSha: parsed.revision.baseSha, headSha: parsed.revision.headSha,
    input: parsed, authorityGeneration: binding.generation,
    bindingAuthorityVersion: binding.version,
    executionModeGeneration: binding.executionModeGeneration ?? 0,
    ...(delivery ? { sourceIdentity: {
      kind: "github_delivery" as const, key: delivery.sourceKey, hash: delivery.sourceHash,
    } } : {}),
  };
  const { provider, model } = resolveModelConfiguration();
  const policy = getModelExecutionPolicy(provider, model);
  const baseManifest = await runtimeVersionManifest(policy);
  const manifest = parsed.workflow === "review.deep.v1" ? withReviewTextVersions(baseManifest, BASELINE_REVIEW_TEXT) : baseManifest;
  const runtimeConfig = { ...AGENT_RUNTIME_CONFIG, modelPolicy: policy,
    ...(parsed.workflow === "review.deep.v1" ? { deepBudget: freezeDeepBudget(policy.runLimits), reviewText: BASELINE_REVIEW_TEXT } : {}) };
  return {
    ...creation, ...manifest,
    runtimeConfig,
    limits: { maxRunMs: AGENT_RUNTIME_CONFIG.maxRunMs, maxJobAttempts: AGENT_RUNTIME_CONFIG.maxJobAttempts,
      maxStepAttempts: AGENT_RUNTIME_CONFIG.maxStepAttempts, model: policy.runLimits },
    admission: (client, runId) => reserveRunBudgetInTransaction(client, { tenantId: binding.tenantId, runId, policy }),
    ...(parsed.workflow === "review.deep.v1" ? { prepareNewRun: async (client) => {
      const selectionInput = { binding, reviewInput: parsed, baseManifest };
      const selected = bindingAllowsCapability(binding, "evolution")
        ? await resolveDeepReleaseSelection(client, selectionInput)
        : resolveBaselineDeepReleaseSelection(selectionInput);
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

function parseTrustedReviewInput(binding: PublicationBinding, input: ReviewRunInput): ReviewRunInput {
  const parsed = reviewRunInputSchema.parse(input);
  if (parsed.platform !== binding.platform || parsed.target.origin !== binding.origin
      || parsed.target.repository !== binding.repository
      || parsed.target.providerRepositoryId !== binding.providerRepositoryId) {
    throw new Error("Review intake target does not match its trusted integration");
  }
  return parsed;
}

function githubDeliveryIdentity(
  binding: PublicationBinding,
  input: ReviewRunInput,
): GitHubDeliveryIdentity | undefined {
  if (input.platform !== "github" || !input.source.key.startsWith("github:delivery:")) return undefined;
  return { tenantId: binding.tenantId, bindingId: binding.id,
    sourceKey: input.source.key, sourceHash: input.source.hash };
}
