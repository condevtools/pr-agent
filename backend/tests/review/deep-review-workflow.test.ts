import assert from "node:assert/strict";
import test from "node:test";

import {
  createDeepReviewWorkflow,
  createDeepWorkflowPolicy,
  gateDeepReviewFindings,
  type DeepReviewArtifact,
  type DeepReviewSource,
  type DeepReviewStore,
  type DeepToolRegistry,
  type DeepWorkflowContext,
  type EvidenceRecord,
} from "../../src/review/deep/index.js";
import type { StructuredModel } from "../../src/model/contracts.js";
import type { RunLease } from "../../src/agent-runtime/runs/contracts.js";
import { fingerprint } from "../../src/agent-runtime/versions.js";

test("deep workflow persists bounded role, critic, gate and shadow artifact steps", async () => {
  const harness = createHarness();
  const artifact = await createDeepReviewWorkflow().execute(harness.source, harness.context, harness.policy);

  assert.equal(artifact.workflowId, "review.deep.v1");
  assert.equal(artifact.publicationMode, "shadow");
  assert.equal(artifact.analysisStatus, "complete");
  assert.equal(artifact.verdict, "findings");
  assert.deepEqual(artifact.coverage.map(({ status }) => status), ["complete", "complete"]);
  assert.equal(artifact.gateDecisions[0]?.accepted, true);
  assert.equal(harness.toolCalls, 1);
  assert.deepEqual([...harness.stepKinds].sort(), [
    "deep.role.security.turn.1:model",
    "deep.role.correctness.turn.1:model",
    "deep.role.security.tool.read_file_range.1:tool",
    "deep.role.correctness.candidates:coordination",
    "deep.role.security.turn.2:model",
    "deep.role.security.candidates:coordination",
    "deep.critic:model",
    "deep.critic.decisions:coordination",
    "deep.gate:verification",
  ].sort());
  assert.equal(harness.savedArtifact?.verdict, "findings");
});

test("durable step reuse does not repeat completed role model or tool actions", async () => {
  const harness = createHarness();
  const workflow = createDeepReviewWorkflow();
  const first = await workflow.execute(harness.source, harness.context, harness.policy);
  const modelCalls = harness.modelCalls;
  const toolCalls = harness.toolCalls;
  const second = await workflow.execute(harness.source, harness.context, harness.policy);

  assert.deepEqual(second, first);
  assert.equal(harness.modelCalls, modelCalls);
  assert.equal(harness.toolCalls, toolCalls);
});

test("a role failure produces an incomplete artifact rather than a clean review", async () => {
  const harness = createHarness({ failCorrectness: true });
  const artifact = await createDeepReviewWorkflow().execute(harness.source, harness.context, harness.policy);

  assert.equal(artifact.analysisStatus, "partial");
  assert.equal(artifact.verdict, "incomplete");
  assert.equal(artifact.coverage.find(({ role }) => role === "correctness")?.status, "failed");
});

test("a transient role failure waits for its peer and retry reuses completed peer steps", async () => {
  const harness = createHarness({ transientCorrectnessOnce: true });
  const workflow = createDeepReviewWorkflow();
  await assert.rejects(workflow.execute(harness.source, harness.context, harness.policy),
    /temporary provider failure/);
  const modelCallsAfterFailure = harness.modelCalls;
  const toolCallsAfterFailure = harness.toolCalls;

  const artifact = await workflow.execute(harness.source, harness.context, harness.policy);
  assert.equal(artifact.analysisStatus, "complete");
  assert.equal(artifact.verdict, "findings");
  assert.equal(harness.toolCalls, toolCallsAfterFailure);
  assert.equal(harness.modelCalls, modelCallsAfterFailure + 2);
});

test("deterministic gate rejects cross-file and wrong-revision evidence even after critic acceptance", () => {
  const harness = createHarness();
  const candidate = candidateFixture();
  const critic = [{ candidateId: candidate.id, decision: "accept" as const, reasonCode: "supported" }];
  const wrongHead = evidenceFixture({ headSha: "other-head" });
  assert.equal(gateDeepReviewFindings({ source: harness.source, candidates: [candidate],
    criticDecisions: critic, evidence: new Map([[wrongHead.id, wrongHead]]) })[0]?.reasonCode,
  "evidence_scope_mismatch");

  const { id: _candidateId, ...crossIdentity } = candidate;
  const crossFile = { ...crossIdentity, crossFileEvidenceIds: ["cross-evidence"] };
  const identifiedCrossFile = { id: fingerprint(crossFile), ...crossFile };
  assert.equal(gateDeepReviewFindings({ source: harness.source, candidates: [identifiedCrossFile],
    criticDecisions: [{ ...critic[0]!, candidateId: identifiedCrossFile.id }], evidence: new Map() })[0]?.reasonCode,
  "cross_file_not_supported");
});

test("gate rejects critic duplicate references and truncated location evidence", () => {
  const harness = createHarness();
  const candidate = candidateFixture();
  const duplicate = gateDeepReviewFindings({ source: harness.source, candidates: [candidate],
    criticDecisions: [{ candidateId: candidate.id, decision: "accept", reasonCode: "duplicate",
      duplicateOfCandidateId: candidate.id }],
    evidence: new Map([["evidence-1", evidenceFixture()]]) });
  assert.equal(duplicate[0]?.reasonCode, "critic_decision_invalid");

  const truncated = evidenceFixture({ truncated: true });
  const ci = evidenceFixture({ id: "ci-evidence", kind: "ci_status", path: undefined,
    startLine: undefined, endLine: undefined, truncated: false });
  const gated = gateDeepReviewFindings({ source: harness.source, candidates: [candidate],
    criticDecisions: [{ candidateId: candidate.id, decision: "accept", reasonCode: "supported" }],
    evidence: new Map([[truncated.id, truncated], [ci.id, ci]]) });
  assert.equal(gated[0]?.reasonCode, "evidence_location_invalid");
});

function createHarness(options: { failCorrectness?: boolean; transientCorrectnessOnce?: boolean } = {}) {
  const lease = leaseFixture();
  const source = sourceFixture(lease);
  const stepCache = new Map<string, unknown>();
  const stepKinds: string[] = [];
  const evidence = new Map<string, EvidenceRecord>();
  let modelCalls = 0;
  let toolCalls = 0;
  let savedArtifact: DeepReviewArtifact | undefined;
  let transientCorrectnessRemaining = options.transientCorrectnessOnce ? 1 : 0;
  const model: StructuredModel = {
    async generate<T>(request): Promise<T> {
      modelCalls += 1;
      if (request.role === "correctness" && options.failCorrectness) throw new Error("role unavailable");
      if (request.role === "correctness" && transientCorrectnessRemaining > 0) {
        transientCorrectnessRemaining -= 1;
        throw Object.assign(new Error("temporary provider failure"), { status: 503 });
      }
      if (request.role === "security" && request.turn === 1) {
        return request.schema.parse({ action: "tool", request: {
          name: "read_file_range", path: "src/a.ts", startLine: 10, endLine: 12,
        } });
      }
      if (request.role === "security") {
        return request.schema.parse({ action: "finish", candidates: [{
          severity: "high", title: "Unsafe trust boundary", body: "The changed line skips validation.",
          location: { path: "src/a.ts", side: "new", startLine: 11, endLine: 11 },
          evidenceIds: ["evidence-1"], crossFileEvidenceIds: [],
        }] });
      }
      if (request.role === "correctness") return request.schema.parse({ action: "finish", candidates: [] });
      const parsed = JSON.parse(request.prompt) as { candidates: Array<{ id: string }> };
      return request.schema.parse({ decisions: parsed.candidates.map(({ id }) => ({
        candidateId: id, decision: "accept", reasonCode: "supported",
      })) });
    },
  };
  const tools: DeepToolRegistry = {
    catalog: () => ["read_file_range"],
    async invoke(_role, name, raw) {
      toolCalls += 1;
      assert.equal(name, "read_file_range");
      assert.equal("name" in (raw as Record<string, unknown>), false);
      return evidenceFixture();
    },
  };
  const store: DeepReviewStore = {
    async loadArtifact() { return savedArtifact; },
    async registerEvidence(_lease, _stepKey, record) { evidence.set(record.id, record); },
    async registerCandidates() {},
    async registerDecisions() {},
    async loadUsableEvidence(_lease, ids) {
      return new Map(ids.flatMap((id) => evidence.has(id) ? [[id, evidence.get(id)!] as const] : []));
    },
    async saveArtifact(_lease, artifact) { savedArtifact = artifact; },
  };
  const context: DeepWorkflowContext = {
    lease, model, tools, store,
    async step<T>(key, kind, _inputHash, action): Promise<T> {
      if (stepCache.has(key)) return stepCache.get(key) as T;
      stepKinds.push(`${key}:${kind}`);
      const value = await action();
      stepCache.set(key, value);
      return value;
    },
  };
  return {
    source, context,
    policy: createDeepWorkflowPolicy({
      roleLimits: {
        security: { maxTurns: 3, maxToolCalls: 3, maxCandidates: 20,
          maxWallTimeMs: 5_000, maxInputBytesPerTurn: 500_000, maxOutputTokensPerTurn: 1_000 },
        correctness: { maxTurns: 3, maxToolCalls: 3, maxCandidates: 20,
          maxWallTimeMs: 5_000, maxInputBytesPerTurn: 500_000, maxOutputTokensPerTurn: 1_000 },
      },
      criticInputCandidateLimit: 40,
      criticLimits: { maxWallTimeMs: 5_000, maxInputBytes: 500_000, maxOutputTokens: 1_000 },
    }),
    get modelCalls() { return modelCalls; },
    get toolCalls() { return toolCalls; },
    get savedArtifact() { return savedArtifact; },
    stepKinds,
  };
}

function leaseFixture(): RunLease {
  const hash = "a".repeat(64);
  return {
    tenantId: "tenant", runId: "run", integrationId: "integration", jobId: "job",
    owner: "worker", epoch: 1, jobAttempt: 1, authorityGeneration: 1, executionModeGeneration: 1,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), baseSha: "base", headSha: "head",
    workflowVersionHash: hash, promptVersionHash: hash, modelVersionHash: hash,
    toolVersionHash: hash, policyVersionHash: hash, runtimeVersionHash: hash,
    input: {}, limits: {}, runtimeConfig: {}, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function sourceFixture(lease: RunLease): DeepReviewSource {
  return {
    identity: { tenantId: lease.tenantId, integrationId: lease.integrationId, runId: lease.runId,
      platform: "github", repository: "acme/repo", baseSha: lease.baseSha, headSha: lease.headSha },
    input: { platform: "github", repository: "acme/repo", number: 1, title: "Change", body: "",
      author: "dev", baseBranch: "main", headBranch: "feature", additions: 1, deletions: 0,
      changedFilesCount: 1, changedFiles: [{ newPath: "src/a.ts", oldPath: "src/a.ts", status: "modified",
        additions: 1, deletions: 0, extendedDiff: "+unsafe();" }] },
    files: [{ path: "src/a.ts", oldPath: "src/a.ts", status: "modified", changedLines: [11] }],
    coverage: { status: "complete", reasonCodes: [] },
  };
}

function candidateFixture() {
  const candidate = {
    sourceRole: "security" as const, severity: "high" as const,
    title: "Unsafe trust boundary", body: "The changed line skips validation.",
    location: { path: "src/a.ts", side: "new" as const, startLine: 11, endLine: 11 },
    evidenceIds: ["evidence-1"], crossFileEvidenceIds: [] as string[],
  };
  return { id: fingerprint(candidate), ...candidate };
}

function evidenceFixture(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return { id: "evidence-1", runId: "run", headSha: "head", kind: "file_range", status: "succeeded",
    path: "src/a.ts", startLine: 10, endLine: 12, contentHash: "b".repeat(64),
    summary: "lines 10-12", truncated: false, ...overrides };
}
