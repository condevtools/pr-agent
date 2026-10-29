import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { gateDeepReviewFindings } from "../src/agents/gate.js";
import type { DeepReviewSource, EvidenceRecord, FindingCandidate } from "../src/agents/contracts.js";
import { fingerprint } from "../src/agent-runtime/versions.js";

const runId = randomUUID();
const source: DeepReviewSource = {
  identity: { tenantId: randomUUID(), integrationId: randomUUID(), runId, platform: "github",
    repository: "acme/deep", baseSha: "base", headSha: "head" },
  input: { platform: "github", repository: "acme/deep", number: 1, title: "Deep", body: "", author: "alice",
    baseBranch: "main", headBranch: "feature", additions: 1, deletions: 0, changedFilesCount: 1,
    changedFiles: [{ newPath: "src/value.ts", oldPath: "src/value.ts", status: "modified", additions: 1,
      deletions: 0, extendedDiff: "+unsafe();" }] },
  files: [{ path: "src/value.ts", oldPath: "src/value.ts", status: "modified", changedLines: [2] }],
  coverage: { status: "complete", reasonCodes: [] },
};
const evidence: EvidenceRecord = { id: fingerprint("evidence"), runId, headSha: "head", kind: "file_range",
  status: "succeeded", path: "src/value.ts", startLine: 1, endLine: 3, contentHash: fingerprint("content"),
  summary: "2: unsafe();", truncated: false };

test("gate rejects a candidate whose identity was forged after model output", () => {
  const candidate = validCandidate(); candidate.id = fingerprint("forged");
  assert.equal(decide(candidate, evidence), "candidate_identity_invalid");
});

test("gate rejects evidence belonging to another Run", () => {
  assert.equal(decide(validCandidate(), { ...evidence, runId: randomUUID() }), "evidence_scope_mismatch");
});

test("gate rejects evidence captured from a stale head revision", () => {
  assert.equal(decide(validCandidate(), { ...evidence, headSha: "old-head" }), "evidence_scope_mismatch");
});

function validCandidate(): FindingCandidate {
  const value = { sourceRole: "security" as const, severity: "high" as const, title: "Unsafe call", body: "Validate input",
    location: { path: "src/value.ts", side: "new" as const, startLine: 2, endLine: 2 },
    evidenceIds: [evidence.id], crossFileEvidenceIds: [] as string[] };
  return { id: fingerprint(value), ...value };
}

function decide(candidate: FindingCandidate, record: EvidenceRecord) {
  return gateDeepReviewFindings({ source, candidates: [candidate],
    criticDecisions: [{ candidateId: candidate.id, decision: "accept", reasonCode: "supported" }],
    evidence: new Map([[record.id, record]]) })[0]!.reasonCode;
}
