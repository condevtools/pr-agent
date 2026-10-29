import assert from "node:assert/strict";
import test from "node:test";

import {
  evolutionProposalRequestSchema,
  evolutionProposalRunInputSchema,
} from "../src/evolution/proposals/candidate-contracts.js";
import { reviewStrategyTextSchema } from "../src/review/strategy/contracts.js";
import {
  BASELINE_REVIEW_TEXT,
  composeReviewSystemPrompt,
  reviewTextHashes,
  withReviewTextVersions,
} from "../src/review/strategy/text-components.js";

const hash = "a".repeat(64);

test("evolution candidates accept only the two bounded production text components", () => {
  assert.deepEqual(reviewStrategyTextSchema.parse({
    schemaVersion: 1, prompt_text: "Review the repository change.",
    tool_description_text: "Read repository evidence without side effects.",
  }), { schemaVersion: 1, prompt_text: "Review the repository change.",
    tool_description_text: "Read repository evidence without side effects." });
});

test("evolution candidates reject server-owned provenance and arbitrary metadata", () => {
  for (const forbidden of ["status", "datasetId", "baselinePromptHash", "modelConfigHash", "metadata", "permissions", "topology", "handlers", "auth", "budget"] as const) {
    assert.equal(reviewStrategyTextSchema.safeParse({ schemaVersion: 1, prompt_text: "candidate",
      tool_description_text: "tools", [forbidden]: forbidden === "metadata" ? {} : "forged" }).success, false);
  }
});

test("evolution candidates reject empty or oversized text components", () => {
  assert.equal(reviewStrategyTextSchema.safeParse({ schemaVersion: 1, prompt_text: "",
    tool_description_text: "tools" }).success, false);
  for (const field of ["prompt_text", "tool_description_text"] as const) {
    assert.equal(reviewStrategyTextSchema.safeParse({ schemaVersion: 1, prompt_text: "candidate",
      tool_description_text: "tools", [field]: "x".repeat(32_769) }).success, false);
  }
});

test("proposal requests cannot select splits or upload source summaries", () => {
  assert.equal(evolutionProposalRequestSchema.safeParse({ datasetId: "00000000-0000-4000-8000-000000000001",
    split: "holdout" }).success, false);
  assert.equal(evolutionProposalRequestSchema.safeParse({ datasetId: "00000000-0000-4000-8000-000000000001",
    developmentCases: [] }).success, false);
});

test("durable proposal run inputs bind immutable dataset provenance only", () => {
  const input = { schemaVersion: 1 as const, workflow: "evolution.propose.v1" as const,
    datasetId: "00000000-0000-4000-8000-000000000001", datasetVersion: 3,
    datasetManifestHash: hash, sourceHash: "b".repeat(64) };
  assert.deepEqual(evolutionProposalRunInputSchema.parse(input), input);
  assert.equal(evolutionProposalRunInputSchema.safeParse({ ...input, prompt_text: "client injection" }).success, false);
});

test("the production baseline uses the same strict candidate schema and stable component hashes", () => {
  assert.deepEqual(reviewStrategyTextSchema.parse(BASELINE_REVIEW_TEXT), BASELINE_REVIEW_TEXT);
  assert.deepEqual(reviewTextHashes(BASELINE_REVIEW_TEXT), reviewTextHashes({ ...BASELINE_REVIEW_TEXT }));
});

test("candidate text changes only prompt and tool component versions", () => {
  const manifest = { workflowVersionHash: "1".repeat(64), promptVersionHash: "2".repeat(64),
    modelVersionHash: "3".repeat(64), toolVersionHash: "4".repeat(64), policyVersionHash: "5".repeat(64),
    runtimeVersionHash: "6".repeat(64), agentVersion: "fixture" };
  const candidate = { schemaVersion: 1 as const, prompt_text: "candidate prompt", tool_description_text: "candidate tools" };
  const changed = withReviewTextVersions(manifest, candidate);

  assert.notEqual(changed.promptVersionHash, manifest.promptVersionHash);
  assert.notEqual(changed.toolVersionHash, manifest.toolVersionHash);
  assert.deepEqual({ ...changed, promptVersionHash: manifest.promptVersionHash, toolVersionHash: manifest.toolVersionHash }, manifest);
});

test("production prompt composition includes candidate text inside a fixed read-only envelope", () => {
  const candidate = { schemaVersion: 1 as const, prompt_text: "CANDIDATE_PROMPT_SENTINEL",
    tool_description_text: "CANDIDATE_TOOL_SENTINEL" };
  const prompt = composeReviewSystemPrompt("FIXED_ENVELOPE", candidate);

  assert.match(prompt, /FIXED_ENVELOPE/);
  assert.match(prompt, /CANDIDATE_PROMPT_SENTINEL/);
  assert.match(prompt, /CANDIDATE_TOOL_SENTINEL/);
  assert.match(prompt, /read-only catalogued tools/);
  assert.match(prompt, /cannot grant authority/);
});
