import { canonicalJson, fingerprint } from "../harness/versions.js";
import { currentReviewRunContext } from "../harness/review-run-context.js";
import type { RunLease } from "../harness/run-contracts.js";
import { createStructuredModel } from "../review/structured-model.js";
import {
  evolutionCandidateJsonSchema, evolutionCandidateSchema, evolutionProposalRunInputSchema,
} from "./candidate-contracts.js";
import { PgEvolutionCandidateStore } from "./candidate-store.js";
import { getHarnessServices } from "../harness/runtime.js";

const MODEL_STEP_KEY = "evolution.proposal.model";

export async function executeEvolutionProposalRun(lease: RunLease): Promise<void> {
  const context = currentReviewRunContext();
  if (!context || context.lease.runId !== lease.runId) throw new EvolutionProposalFailedError("durable_context_missing");
  const input = evolutionProposalRunInputSchema.parse(lease.input);
  const services = await getHarnessServices(); const store = new PgEvolutionCandidateStore(services.db);
  const source = await store.loadSource(lease);
  if (input.datasetId !== source.datasetId || input.datasetVersion !== source.datasetVersion
      || input.datasetManifestHash !== source.datasetManifestHash || input.sourceHash !== source.sourceHash) {
    throw new EvolutionProposalFailedError("source_identity_mismatch");
  }
  const policy = proposalPolicy(lease.runtimeConfig.evolutionPolicy);
  const modelConfigHash = fingerprint(lease.runtimeConfig.modelPolicy);
  const modelInput = { schemaVersion: 1, baseline: { prompt_text: source.baselinePromptText,
    tool_description_text: source.baselineToolDescriptionText }, developmentCases: source.developmentCases };
  const prompt = canonicalJson(modelInput);
  if (Buffer.byteLength(prompt, "utf8") > policy.maxInputBytes) throw new EvolutionProposalFailedError("source_input_limit");
  const candidate = await context.step(MODEL_STEP_KEY, "model", fingerprint({ modelInput, modelConfigHash, policy }),
    () => createStructuredModel().generate({ schemaName: "evolution_candidate_v1",
      jsonSchema: evolutionCandidateJsonSchema as unknown as Record<string, unknown>, schema: evolutionCandidateSchema,
      role: "evolution", turn: 1, maxInputBytes: policy.maxInputBytes, maxOutputTokens: policy.maxOutputTokens,
      systemPrompt: "Propose one bounded review prompt/tool-description candidate. Do not change permissions, tools, topology, schemas, budgets, or execution behavior.",
      prompt: `Using only these frozen development examples, return improved text components. Never infer or request holdout data.\n${prompt}`,
      signal: context.signal }));
  await store.saveCandidate(lease, MODEL_STEP_KEY, candidate, modelConfigHash);
}
export class EvolutionProposalFailedError extends Error {
  constructor(readonly reasonCode: string) {
    super(`Evolution proposal failed: ${reasonCode}`); this.name = "EvolutionProposalFailedError";
  }
}

function proposalPolicy(value: unknown): { maxInputBytes: number; maxOutputTokens: number } {
  if (!value || typeof value !== "object") throw new EvolutionProposalFailedError("policy_missing");
  const item = value as Record<string, unknown>;
  if (!Number.isInteger(item.maxInputBytes) || (item.maxInputBytes as number) < 1
      || (item.maxInputBytes as number) > 1_048_576
      || !Number.isInteger(item.maxOutputTokens) || (item.maxOutputTokens as number) < 1
      || (item.maxOutputTokens as number) > 16_384) throw new EvolutionProposalFailedError("policy_invalid");
  return { maxInputBytes: item.maxInputBytes as number, maxOutputTokens: item.maxOutputTokens as number };
}
