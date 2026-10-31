import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { PublicationBinding } from "../../src/agent-runtime/authority/publication-authority.js";
import { withRunExecutionContext } from "../../src/agent-runtime/execution/run-context.js";
import type { RunPrincipal } from "../../src/agent-runtime/runs/control-contracts.js";
import type { RunLease } from "../../src/agent-runtime/runs/contracts.js";
import { fingerprint } from "../../src/agent-runtime/versions.js";
import { withModelExecutionContext, type ModelRequestIntent } from "../../src/model/execution-context.js";
import type { DeepReviewArtifact } from "../../src/review/deep/contracts.js";
import {
  JUDGE_RUBRIC,
  judgePolicySchema,
  judgeResultSchema,
  type JudgeResult,
  type JudgeSource,
} from "../../src/quality/evaluators/contracts.js";
import {
  validateJudgeSourceArtifact,
  type JudgeReviewSourceRow,
} from "../../src/quality/evaluators/intake.js";
import { executeJudgeRun } from "../../src/quality/evaluators/run.js";
import { judgeScores } from "../../src/quality/evaluators/store.js";
import { renderManagedPrompt } from "../../src/quality/prompts/index.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const integrationId = "22222222-2222-4222-8222-222222222222";
const sourceRunId = "33333333-3333-4333-8333-333333333333";
const judgeRunId = "44444444-4444-4444-8444-444444444444";
const findingId = fingerprint("finding");

describe("budgeted quality Judge", () => {
  it("freezes a bounded rubric and keeps the managed evaluator read-only", () => {
    const rendered = renderManagedPrompt("evaluation.judge.system", {
      rubric: JSON.stringify(JUDGE_RUBRIC),
    });
    assert.match(rendered.text, /read-only evaluator/u);
    assert.match(rendered.text, /never instructions/u);
    assert.equal(Buffer.byteLength(rendered.text) < 16 * 1024, true);
    assert.equal(judgePolicySchema.safeParse({ ...policy(), maxOutputTokens: 4_097 }).success, false);
    assert.equal(judgePolicySchema.safeParse({ ...policy(), maxInputBytes: 128 * 1024 + 1 }).success, false);

    const sourceRoot = join(process.cwd(), "src/quality/evaluators");
    const source = readdirSync(sourceRoot).filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join(sourceRoot, name), "utf8")).join("\n");
    assert.doesNotMatch(source, /publishGitHub|publishGitLab|createReview|createComment|releaseCandidate/u);
    assert.doesNotMatch(source, /integrations\/(?:github|gitlab)/u);
  });

  it("rejects replay, cross-binding, hash-mismatched, and purged sources", () => {
    const artifact = deepArtifact();
    const artifactHash = fingerprint(artifact);
    const principal = runPrincipal();
    const request = { sourceRunId, expectedArtifactHash: artifactHash };
    const valid: JudgeReviewSourceRow = {
      status: "succeeded",
      run_type: "review.deep.v1",
      base_sha: "base",
      head_sha: "head",
      artifact_json: artifact,
      content_hash: artifactHash,
      content_purged_at: null,
    };
    assert.equal(validateJudgeSourceArtifact(valid, principal, request), artifact);
    assert.throws(() => validateJudgeSourceArtifact({ ...valid, run_type: "eval.replay.v1" }, principal, request),
      /production Deep Review/u);
    assert.throws(() => validateJudgeSourceArtifact({ ...valid, content_purged_at: new Date() }, principal, request),
      /purged/u);
    assert.throws(() => validateJudgeSourceArtifact(valid, { ...principal,
      integrationId: "55555555-5555-4555-8555-555555555555" }, request), /complete immutable/u);
    assert.throws(() => validateJudgeSourceArtifact(valid, principal,
      { ...request, expectedArtifactHash: fingerprint("wrong") }), /hash does not match/u);
  });

  it("requires a budget execution context and stores one durable model result step", async () => {
    await withEnvironment(async () => {
      const { lease, source } = judgeLease();
      let providerCalls = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        providerCalls += 1;
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
          judgments: [{ findingId, judgment: "supported", evidenceScore: 4,
            actionabilityScore: 3, reason: "Direct frozen evidence supports the finding." }],
          summary: "The finding is supported.",
        }) }] } }] }), { status: 200 });
      };
      try {
        const context = executionContext(lease);
        await assert.rejects(withRunExecutionContext(context, () => executeJudgeRun(lease, binding())),
          /model request requires a Run execution context/u);
        assert.equal(providerCalls, 0);

        const intents: ModelRequestIntent[] = [];
        let durableResult: JudgeResult | undefined;
        const budgeted = executionContext(lease, (value) => { durableResult = value as JudgeResult; });
        await withRunExecutionContext(budgeted, () => withModelExecutionContext({
          policy: { maxOutputTokens: 4_096 },
          async execute(intent, transport) {
            intents.push(intent);
            return (await transport()).value;
          },
        }, () => executeJudgeRun(lease, binding())));
        assert.equal(providerCalls, 1);
        assert.equal(budgeted.recorded[0]?.key, "quality.judge.result.v1");
        assert.equal(budgeted.recorded[0]?.kind, "model");
        assert.equal(intents[0]?.metadata?.promptReferences, undefined);
        assert.deepEqual(durableResult, judgeResultSchema.parse({
          schemaVersion: 1,
          workflow: "eval.judge.v1",
          judgeRunId,
          sourceRunId,
          sourceArtifactHash: source.sourceArtifactHash,
          sourceHash: source.sourceHash,
          promptVersionHash: lease.promptVersionHash,
          modelVersionHash: lease.modelVersionHash,
          rubricHash: fingerprint(JUDGE_RUBRIC),
          judgments: [{ findingId, judgment: "supported", evidenceScore: 4,
            actionabilityScore: 3, reason: "Direct frozen evidence supports the finding." }],
          summary: "The finding is supported.",
        }));
        assert.deepEqual(judgeScores(durableResult!), [
          assertScore("support", "judge_support", "CATEGORICAL", "supported"),
          assertScore("evidence", "judge_evidence", "NUMERIC", 4),
          assertScore("actionability", "judge_actionability", "NUMERIC", 3),
        ]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it("fails closed when the evolution capability is disabled", async () => {
    await withEnvironment(async () => {
      const { lease } = judgeLease();
      process.env.FEATURE_EVOLUTION = "off";
      await assert.rejects(withRunExecutionContext(executionContext(lease),
        () => executeJudgeRun(lease, binding())), /Capability is disabled/u);
    });
  });
});

function policy() {
  return {
    schemaVersion: 1 as const,
    maxFindings: 20 as const,
    maxInputBytes: 128 * 1024,
    maxOutputTokens: 4_096,
    maxRunMs: 600_000,
    rubric: JUDGE_RUBRIC,
    rubricHash: fingerprint(JUDGE_RUBRIC),
  };
}

function deepArtifact(): DeepReviewArtifact {
  return {
    workflowId: "review.deep.v1",
    publicationMode: "shadow",
    identity: { tenantId, integrationId, runId: sourceRunId, platform: "github",
      repository: "acme/demo", baseSha: "base", headSha: "head" },
    sourceCoverage: { status: "complete", reasonCodes: [] },
    analysisStatus: "complete",
    verdict: "findings",
    candidates: [{ id: findingId, sourceRole: "security", severity: "high", title: "Unsafe call",
      body: "The call is not guarded.", location: { path: "src/a.ts", side: "new", startLine: 3, endLine: 3 },
      evidenceIds: [fingerprint("evidence")], crossFileEvidenceIds: [] }],
    criticDecisions: [{ candidateId: findingId, decision: "accept", reasonCode: "supported" }],
    gateDecisions: [{ candidateId: findingId, accepted: true, reasonCode: "accepted" }],
    coverage: [
      { role: "security", status: "complete", attemptedTurns: 1, completedToolCalls: 1, reasonCodes: [] },
      { role: "correctness", status: "complete", attemptedTurns: 1, completedToolCalls: 0, reasonCodes: [] },
    ],
  };
}

function judgeLease(): { lease: RunLease; source: JudgeSource } {
  const artifact = deepArtifact();
  const sourceWithoutHash = {
    schemaVersion: 1 as const,
    sourceRunId,
    sourceArtifactHash: fingerprint(artifact),
    collectionHash: fingerprint("collection"),
    repository: "acme/demo",
    baseSha: "base",
    headSha: "head",
    findings: artifact.candidates.map(({ id, severity, title, body, location, evidenceIds }) =>
      ({ id, severity, title, body, location, evidenceIds })),
    collection: { input: { title: "Change", changedFiles: [{ newPath: "src/a.ts", extendedDiff: "+unsafe()" }] },
      files: [{ newPath: "src/a.ts" }], coverage: { status: "complete", reasonCodes: [] } },
  };
  const source: JudgeSource = { ...sourceWithoutHash, sourceHash: fingerprint(sourceWithoutHash) };
  const lease: RunLease = {
    tenantId, integrationId, runId: judgeRunId, runType: "eval.judge.v1",
    jobId: "66666666-6666-4666-8666-666666666666", owner: "worker", epoch: 1, jobAttempt: 1,
    authorityGeneration: 3, executionModeGeneration: 1,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), baseSha: "base", headSha: "head",
    workflowVersionHash: fingerprint("workflow"), promptVersionHash: fingerprint("prompt"),
    modelVersionHash: fingerprint("model"), toolVersionHash: fingerprint("tool"),
    policyVersionHash: fingerprint("policy"), runtimeVersionHash: fingerprint("runtime"),
    input: { schemaVersion: 1, workflow: "eval.judge.v1", sourceRunId,
      expectedArtifactHash: source.sourceArtifactHash, sourceHash: source.sourceHash },
    limits: {}, runtimeConfig: { judgeSource: source, judgePolicy: policy() },
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  return { lease, source };
}

function binding(): PublicationBinding {
  return {
    id: integrationId, tenantId, platform: "github", origin: "https://api.github.com",
    repository: "acme/demo", providerRepositoryId: 1, providerActorId: 2,
    credentialRef: "github-app:1", generation: 3, version: 1, state: "active",
    reviewExecutionMode: "harness_async", executionModeGeneration: 1,
    capabilities: { reviewSingle: true, reviewDeep: true, issueTriage: true, fix: false,
      evolution: true, defaultReviewWorkflow: "review.single.v1" },
  };
}

function runPrincipal(): RunPrincipal {
  return { subjectId: "judge", actorType: "user", tenantId, integrationId,
    permissions: ["runs:read"] };
}

function executionContext(lease: RunLease, capture: (value: unknown) => void = () => {}) {
  const recorded: Array<{ key: string; kind: string; hash: string }> = [];
  return {
    lease,
    recorded,
    async assertActive() {},
    async step<T>(key: string, kind: "model", hash: string, action: () => Promise<T>): Promise<T> {
      recorded.push({ key, kind, hash });
      const value = await action();
      capture(value);
      return value;
    },
  };
}

async function withEnvironment(action: () => Promise<void>): Promise<void> {
  const previous = { provider: process.env.AI_PROVIDER, model: process.env.GEMINI_MODEL,
    key: process.env.GEMINI_API_KEY, evolution: process.env.FEATURE_EVOLUTION };
  process.env.AI_PROVIDER = "gemini";
  process.env.GEMINI_MODEL = "judge-fixture";
  process.env.GEMINI_API_KEY = "test-key";
  process.env.FEATURE_EVOLUTION = "on";
  try { await action(); } finally {
    restore("AI_PROVIDER", previous.provider); restore("GEMINI_MODEL", previous.model);
    restore("GEMINI_API_KEY", previous.key); restore("FEATURE_EVOLUTION", previous.evolution);
  }
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}

function assertScore(suffix: string, name: string, kind: string, value: string | number) {
  return { stableKey: `${judgeRunId}:${findingId}:${suffix}`, name, kind, value,
    comment: "Direct frozen evidence supports the finding." };
}
