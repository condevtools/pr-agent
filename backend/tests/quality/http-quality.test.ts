import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { parseQualityCliArguments, runQualityCli } from "../../scripts/quality-langfuse.ts";
import type { RunPrincipal } from "../../src/agent-runtime/runs/control-contracts.js";
import { QualityController } from "../../src/http/quality/quality.controller.js";
import { QualityModule } from "../../src/http/quality/quality.module.js";
import { QualityService, buildQualitySyncJobInput } from "../../src/http/quality/quality.service.js";
import { annotationPromotionSchema, datasetExportSchema, promptPullSchema,
  scoresExportSchema } from "../../src/http/quality/input.js";

test("quality module exposes its guarded controller and service", () => {
  assert.deepEqual(Reflect.getMetadata("controllers", QualityModule), [QualityController]);
  assert.deepEqual(Reflect.getMetadata("providers", QualityModule), [QualityService]);
});

test("quality request schemas reject holdout export, unknown fields, and raw-score promotion", () => {
  assert.throws(() => datasetExportSchema.parse({ datasetId: randomUUID(), split: "holdout",
    expectedManifestHash: "a".repeat(64) }));
  assert.throws(() => promptPullSchema.parse({ promptKey: "issues.triage.system",
    remoteName: "pr-agent.issues.triage.system", version: 1, token: "must-not-be-accepted" }));
  assert.throws(() => annotationPromotionSchema.parse({ expectedContentHash: "a".repeat(64),
    artifactHash: "b".repeat(64), score: { value: 1 }, labelSet: labelSet() }));
  const parsed = annotationPromotionSchema.parse({ expectedContentHash: "a".repeat(64),
    artifactHash: "b".repeat(64), labelSet: labelSet(), notes: "Reviewed the complete diff." });
  assert.equal(parsed.labelSet.completeness, "complete");
  assert.equal(scoresExportSchema.parse({ judgeRunId: randomUUID() }).judgeRunId.length, 36);
  assert.throws(() => scoresExportSchema.parse({ judgeRunId: randomUUID(), evaluationId: randomUUID(),
    expectedManifestHash: "a".repeat(64) }));
});

test("quality job envelope freezes identical authenticated scope in payload and principal", () => {
  const principal: RunPrincipal = { subjectId: "quality-operator", actorType: "user",
    tenantId: randomUUID(), integrationId: randomUUID(),
    permissions: ["quality:sync:execute", "evaluations:read"] };
  const first = buildQualitySyncJobInput(principal, "c".repeat(64), "dataset_export", "export-1", {
    datasetId: randomUUID(), split: "development", expectedManifestHash: "d".repeat(64),
  });
  const replay = buildQualitySyncJobInput(principal, "c".repeat(64), "dataset_export", "export-1", {
    datasetId: first.payload.datasetId, split: "development", expectedManifestHash: "d".repeat(64),
  });
  assert.equal(first.externalId, replay.externalId);
  assert.equal(first.requestHash, replay.requestHash);
  assert.deepEqual(first.payload.principal, first.principal);
  assert.equal(first.targetFingerprint, "c".repeat(64));
});

test("quality CLI parses bounded options and never requires Langfuse or database credentials", async () => {
  assert.deepEqual(parseQualityCliArguments(["jobs", "get", "--id", randomUUID()]).command, "jobs:get");
  assert.throws(() => parseQualityCliArguments(["jobs", "get", "--id", "one", "--id", "two"]), /duplicate option/u);
  await assert.rejects(runQualityCli(["prompts", "list"], {}, () => undefined),
    /PR_AGENT_API_URL and PR_AGENT_API_TOKEN are required/u);
});

test("quality CLI exports judge scores through the guarded API without exposing its bearer", async () => {
  const originalFetch = globalThis.fetch;
  const judgeRunId = randomUUID();
  let observed: { url: string; authorization: string | null; key: string | null; body: unknown } | undefined;
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    observed = { url: String(input), authorization: headers.get("authorization"),
      key: headers.get("idempotency-key"), body: JSON.parse(String(init?.body)) as unknown };
    return new Response(JSON.stringify({ id: randomUUID() }), { status: 202,
      headers: { "content-type": "application/json" } });
  };
  try {
    const output: unknown[] = [];
    await runQualityCli(["judge", "export", "--id", judgeRunId, "--idempotency-key", "judge-score-1"],
      { PR_AGENT_API_URL: "http://127.0.0.1:3000", PR_AGENT_API_TOKEN: "secret-bearer" },
      (value) => output.push(value));
    assert.deepEqual(observed, { url: "http://127.0.0.1:3000/quality/exports/scores",
      authorization: "Bearer secret-bearer", key: "judge-score-1", body: { judgeRunId } });
    assert.equal(JSON.stringify(output).includes("secret-bearer"), false);
  } finally { globalThis.fetch = originalFetch; }
});

function labelSet() {
  return { schemaVersion: 1 as const, rubricVersion: "review-quality.v1" as const,
    completeness: "complete" as const, expectedFindings: [] };
}
