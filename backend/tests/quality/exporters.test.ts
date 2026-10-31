import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RunPrincipal } from "../../src/agent-runtime/runs/control-contracts.js";
import type { DatasetStorePort } from "../../src/evolution/datasets/contracts.js";
import type { JudgeResult } from "../../src/quality/evaluators/contracts.js";
import type { LangfuseQualityPort, UpsertDatasetItemInput, UpsertScoreInput } from "../../src/quality/langfuse/contracts.js";
import { createQualitySyncHandlers, QualitySyncExportError } from "../../src/quality/sync/exporters.js";
import { QualityExportSourceError, QualitySourceReader, type DatasetExportSource,
  type EvaluationExportSource, type QualitySourceReaderPort } from "../../src/quality/sync/source-reader.js";
import type { EnqueueQualitySyncJobInput, QualityAnnotationImport, QualityScope,
  QualitySyncJob, QualityTraceLink } from "../../src/quality/storage/contracts.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const INTEGRATION = "22222222-2222-4222-8222-222222222222";
const OTHER_INTEGRATION = "33333333-3333-4333-8333-333333333333";
const DATASET = "44444444-4444-4444-8444-444444444444";
const CASE = "55555555-5555-4555-8555-555555555555";
const RUN = "66666666-6666-4666-8666-666666666666";
const EVALUATION = "77777777-7777-4777-8777-777777777777";
const RESULT = "88888888-8888-4888-8888-888888888888";
const JUDGE_RUN = "99999999-9999-4999-8999-999999999999";
const HASH = "a".repeat(64);
const DATASET_HASH = "b".repeat(64);
const FIXTURE_HASH = "c".repeat(64);
const LABEL_HASH = "d".repeat(64);
const SCORE_HASH = "e".repeat(64);
const TRACE = "f".repeat(32);

const principal: RunPrincipal = {
  subjectId: "quality-admin",
  actorType: "service",
  tenantId: TENANT,
  integrationId: INTEGRATION,
  permissions: ["evaluations:read", "runs:read", "quality:sync:execute", "quality:evaluators:run"],
};

describe("quality sync exporters", () => {
  it("exports redacted frozen dataset items with trusted-label provenance and stable identities", async () => {
    const client = new FakeLangfuseClient();
    const handlers = handlersFor(client, new FakeSourceReader());

    const result = await handlers.dataset_export(job("dataset_export", {
      datasetId: DATASET,
      split: "development",
      expectedManifestHash: DATASET_HASH,
      principal,
    }));

    assert.equal(result.exported, 1);
    assert.equal(client.datasets.length, 1);
    assert.equal(client.items.length, 1);
    const item = client.items[0]!;
    assert.equal((item.input as { input: { apiKey: string } }).input.apiKey, "[REDACTED]");
    assert.deepEqual(item.expectedOutput, { completeness: "complete", expectedFindings: [] });
    assert.deepEqual((item.metadata as { labelProvenance: object }).labelProvenance, {
      kind: "trusted_review_label_set",
      source: "postgres_trusted_review_label_sets",
      trusted: true,
      labelSetId: CASE,
      labelSetHash: LABEL_HASH,
    });
    assert.match(item.stableKey, new RegExp(`${TENANT}:${INTEGRATION}:${DATASET}:${DATASET_HASH}`));
  });

  it("rejects oversized dataset content instead of truncating it", async () => {
    const source = new FakeSourceReader();
    source.dataset.cases[0]!.fixture.files[0]!.content = "x".repeat(2_000);
    source.dataset.cases[0]!.fixture.files[0]!.sizeBytes = 2_000;
    const client = new FakeLangfuseClient();
    const handlers = handlersFor(client, source, { QUALITY_LANGFUSE_MAX_ITEM_BYTES: "1024" });

    await assert.rejects(
      handlers.dataset_export(job("dataset_export", { datasetId: DATASET, split: "development",
        expectedManifestHash: DATASET_HASH, principal })),
      (error) => error instanceof QualitySyncExportError && error.code === "QUALITY_DATASET_ITEM_OVERSIZED",
    );
    assert.equal(client.items.length, 0);
  });

  it("stops issuing remote dataset writes after lifecycle cancellation", async () => {
    const source = new FakeSourceReader();
    source.dataset.cases.push({ ...source.dataset.cases[0]!, caseId: RESULT, ordinal: 1 });
    const controller = new AbortController();
    const client = new FakeLangfuseClient();
    client.abortAfterFirstItem = controller;
    const handlers = handlersFor(client, source);

    await assert.rejects(handlers.dataset_export(job("dataset_export", { datasetId: DATASET,
      split: "development", expectedManifestHash: DATASET_HASH, principal }), { signal: controller.signal }),
    (error) => error instanceof Error && error.name === "AbortError");
    assert.equal(client.items.length, 1);
  });

  it("links scored evaluation child traces and exports deterministic scorer metrics with hashes", async () => {
    const client = new FakeLangfuseClient();
    const source = new FakeSourceReader();
    const handlers = handlersFor(client, source);

    const result = await handlers.evaluation_export(job("evaluation_export", {
      evaluationId: EVALUATION,
      expectedManifestHash: HASH,
      principal,
    }));

    assert.equal(result.linked, 1);
    assert.equal(result.scoresExported, 7);
    assert.equal(client.runItems.length, 1);
    assert.equal(client.scores.length, 7);
    assert.deepEqual(client.scores.map(({ name }) => name), [
      "eval_precision", "eval_recall", "eval_f1", "eval_severity_weighted_f1",
      "eval_safety_regression", "eval_high_false_positives", "eval_high_false_negatives",
    ]);
    assert.equal((client.scores[0]!.metadata as { expectedHashes: { prompt: string } }).expectedHashes.prompt, HASH);
    assert(client.scores.every(({ stableKey }) => stableKey.includes(SCORE_HASH)));
  });

  it("exports evaluation results to the latest trace attempt for the current target", async () => {
    const client = new FakeLangfuseClient();
    const links = [traceLink(1, "1".repeat(32)),
      { ...traceLink(2, "2".repeat(32)), targetFingerprint: DATASET_HASH },
      traceLink(3, "3".repeat(32))];
    const handlers = handlersFor(client, new FakeSourceReader(), {}, new FakeAnnotationStore(), undefined, links);

    await handlers.evaluation_export(job("evaluation_export", {
      evaluationId: EVALUATION, expectedManifestHash: HASH, principal,
    }));

    assert.equal((client.runItems[0] as { traceId: string }).traceId, "3".repeat(32));
    assert(client.scores.every(({ traceId }) => traceId === "3".repeat(32)));
  });

  it("uses a distinct Langfuse experiment run for every variant and repetition", async () => {
    const client = new FakeLangfuseClient();
    const source = new FakeSourceReader();
    const original = source.evaluation.results[0]!;
    source.evaluation.results = (["baseline", "candidate"] as const).flatMap((variant) => [1, 2].map((repetition) => ({
      ...original,
      resultId: `${RESULT}-${variant}-${repetition}`,
      variant,
      repetition,
    })));
    const handlers = handlersFor(client, source);

    const result = await handlers.evaluation_export(job("evaluation_export", {
      evaluationId: EVALUATION, expectedManifestHash: HASH, principal,
    }));

    const runNames = client.runItems.map((item) => (item as { runName: string }).runName);
    assert.equal(new Set(runNames).size, 4);
    assert.deepEqual(result.runNames, [...new Set(runNames)].sort());
    assert.equal(result.runCount, 4);
    assert.equal(result.linked, 4);
  });

  it("never exports holdout case content or trace-level scores", async () => {
    const client = new FakeLangfuseClient();
    const source = new FakeSourceReader();
    source.evaluation.split = "holdout";
    const handlers = handlersFor(client, source);

    const result = await handlers.evaluation_export(job("evaluation_export", {
      evaluationId: EVALUATION,
      expectedManifestHash: HASH,
      principal,
    }));

    assert.equal(result.aggregateOnly, true);
    assert.equal(result.remoteWrites, 0);
    assert.equal(client.runItems.length, 0);
    assert.equal(client.scores.length, 0);
  });

  it("exports untrusted Judge metrics only to the scoped trace for the frozen Judge run", async () => {
    const client = new FakeLangfuseClient();
    const judgeResult = frozenJudgeResult();
    const handlers = handlersFor(client, new FakeSourceReader(), {}, new FakeAnnotationStore(), {
      read: async (_db, inputPrincipal, judgeRunId) => {
        assert.equal(judgeRunId, JUDGE_RUN);
        assert.equal(inputPrincipal.integrationId, INTEGRATION);
        return judgeResult;
      },
    });

    const result = await handlers.scores_export(job("scores_export", { judgeRunId: JUDGE_RUN, principal }));

    assert.deepEqual(result, { judgeRunId: JUDGE_RUN, sourceRunId: RUN, traceId: TRACE,
      scoresExported: 3, trustedLabel: false });
    assert.deepEqual(client.scores.map(({ name, kind, value }) => ({ name, kind, value })), [
      { name: "judge_support", kind: "CATEGORICAL", value: "supported" },
      { name: "judge_evidence", kind: "NUMERIC", value: 4 },
      { name: "judge_actionability", kind: "NUMERIC", value: 3 },
    ]);
    assert(client.scores.every(({ traceId, metadata }) => traceId === TRACE
      && metadata?.trustedLabel === false && metadata?.sourceArtifactHash === HASH));
  });

  it("exports Judge scores to the latest trace attempt for the current target", async () => {
    const client = new FakeLangfuseClient();
    const handlers = handlersFor(client, new FakeSourceReader(), {}, new FakeAnnotationStore(), {
      read: async () => frozenJudgeResult(),
    }, [traceLink(1, "1".repeat(32)), traceLink(4, "4".repeat(32))]);

    const result = await handlers.scores_export(job("scores_export", { judgeRunId: JUDGE_RUN, principal }));

    assert.equal(result.traceId, "4".repeat(32));
    assert(client.scores.every(({ traceId }) => traceId === "4".repeat(32)));
  });

  it("rejects Judge score export without evaluator authority before reading the Judge result", async () => {
    const client = new FakeLangfuseClient();
    let reads = 0;
    const restricted = { ...principal,
      permissions: ["runs:read", "quality:sync:execute"] as RunPrincipal["permissions"] };
    const handlers = handlersFor(client, new FakeSourceReader(), {}, new FakeAnnotationStore(), {
      read: async () => { reads += 1; return frozenJudgeResult(); },
    });

    await assert.rejects(
      handlers.scores_export(job("scores_export", { judgeRunId: JUDGE_RUN, principal: restricted }, restricted)),
      (error: unknown) => error instanceof Error && error.name === "RunControlError",
    );
    assert.equal(reads, 0);
    assert.equal(client.scores.length, 0);
  });

  it("rejects Judge score export when the Judge trace is absent from the current target", async () => {
    const client = new FakeLangfuseClient();
    const handlers = handlersFor(client, new FakeSourceReader(), {}, new FakeAnnotationStore(), {
      read: async () => frozenJudgeResult(),
    }, []);

    await assert.rejects(
      handlers.scores_export(job("scores_export", { judgeRunId: JUDGE_RUN, principal })),
      (error) => error instanceof QualitySyncExportError
        && error.code === "QUALITY_JUDGE_TRACE_LINK_UNAVAILABLE",
    );
    assert.equal(client.scores.length, 0);
  });

  it("creates a scoped human queue and imports annotations as pending untrusted evidence", async () => {
    const client = new FakeLangfuseClient();
    const annotationStore = new FakeAnnotationStore();
    const handlers = handlersFor(client, new FakeSourceReader(), {}, annotationStore);

    const queued = await handlers.annotation_queue(job("annotation_queue", { sourceRunId: RUN, principal }));
    const pulled = await handlers.annotation_pull(job("annotation_pull", { sourceRunId: RUN, principal }));

    assert.equal(queued.enqueued, 1);
    assert.equal(pulled.importedPending, 1);
    assert.equal(client.queueItems[0]?.objectId, TRACE);
    assert.equal(annotationStore.imports[0]?.score.trustedLabel, false);
    assert.equal(annotationStore.imports[0]?.score.provenance, "langfuse_human_annotation");
    assert.equal(annotationStore.imports[0]?.traceLinkId, "trace-link-1");
  });

  it("durably continues annotation pagination beyond 500 scores without silent truncation", async () => {
    const client = new FakeLangfuseClient();
    client.annotationPages = Array.from({ length: 6 }, (_, page) => ({
      scores: Array.from({ length: page < 5 ? 100 : 1 }, (_unused, index) => ({
        id: `human-${page}-${index}`, traceId: TRACE, name: "human_review",
        kind: "CATEGORICAL" as const, value: "correct", configId: "score-config",
        queueId: "queue-1", timestamp: new Date(0).toISOString(),
      })),
      ...(page < 5 ? { nextCursor: `cursor-${page + 1}` } : {}),
    }));
    const queued: EnqueueQualitySyncJobInput[] = [];
    const handlers = handlersFor(client, new FakeSourceReader(), {}, new FakeAnnotationStore(), undefined,
      undefined, async (_scope, input) => { queued.push(input); return job("annotation_pull", input.payload); });
    let current = job("annotation_pull", { sourceRunId: RUN, principal });
    let inspected = 0;
    for (;;) {
      const result = await handlers.annotation_pull(current);
      inspected += Number(result.inspected);
      const next = queued.shift();
      if (!next) break;
      current = job("annotation_pull", next.payload);
    }

    assert.equal(inspected, 501);
    assert.equal(client.annotationPages.length, 0);
  });

  it("rejects mismatched principal snapshots before reading sources", async () => {
    const handlers = handlersFor(new FakeLangfuseClient(), new FakeSourceReader());
    await assert.rejects(
      handlers.dataset_export(job("dataset_export", { datasetId: DATASET, split: "development",
        expectedManifestHash: DATASET_HASH, principal: { ...principal, subjectId: "other" } })),
      (error) => error instanceof QualitySyncExportError && error.code === "QUALITY_PRINCIPAL_SNAPSHOT_MISMATCH",
    );
  });
});

describe("QualitySourceReader guards", () => {
  it("denies holdout dataset reads unconditionally", async () => {
    const reader = new QualitySourceReader({} as never, {} as DatasetStorePort);
    await assert.rejects(
      reader.readDataset(principal, { datasetId: DATASET, split: "holdout" as never, expectedManifestHash: HASH }),
      (error) => error instanceof QualityExportSourceError && error.code === "QUALITY_HOLDOUT_EXPORT_FORBIDDEN",
    );
  });

  it("rejects cases from a different integration instead of filtering them out", async () => {
    const datasetStore: DatasetStorePort = {
      read: async () => ({ id: DATASET, name: "dataset", status: "frozen", version: 2,
        splitPolicy: { schemaVersion: 1, strategy: "repository_time_v1", developmentBefore: new Date(0).toISOString(),
          validationBefore: new Date(1).toISOString(), nearDuplicateThreshold: 0.85 },
        manifestHash: DATASET_HASH, caseCount: 1, developmentCount: 1, validationCount: 0, holdoutCount: 0,
        frozenAt: new Date(2).toISOString(), createdAt: new Date(0).toISOString() }),
      readFixture: async () => fixture(),
      create: async () => { throw new Error("unused"); },
      loadCaseSource: async () => { throw new Error("unused"); },
      addCase: async () => { throw new Error("unused"); },
      freeze: async () => { throw new Error("unused"); },
    };
    const db = { transaction: async (_tenant: string, fn: (client: object) => Promise<unknown>) => fn({
      query: async () => ({ rows: [{ id: CASE, integration_id: OTHER_INTEGRATION, source_run_id: RUN,
        fixture_hash: FIXTURE_HASH, label_set_id: CASE, label_set_hash: LABEL_HASH,
        label_set_json: {}, ordinal: 0, content_purged_at: null, label_active: true,
        label_content_purged_at: null, current_label_set_hash: LABEL_HASH }] }),
    }), };
    const reader = new QualitySourceReader(db as never, datasetStore);
    await assert.rejects(
      reader.readDataset(principal, { datasetId: DATASET, split: "development", expectedManifestHash: DATASET_HASH }),
      (error) => error instanceof QualityExportSourceError && error.code === "QUALITY_CROSS_BINDING_SOURCE",
    );
  });
});

class FakeSourceReader implements QualitySourceReaderPort {
  dataset: DatasetExportSource = {
    datasetId: DATASET,
    datasetName: "reviews",
    datasetVersion: 2,
    manifestHash: DATASET_HASH,
    split: "development",
    counts: { development: 1, validation: 0, holdout: 2 },
    cases: [{ caseId: CASE, sourceRunId: RUN, fixtureHash: FIXTURE_HASH, labelSetId: CASE,
      labelSetHash: LABEL_HASH, labelSet: { completeness: "complete", expectedFindings: [] }, ordinal: 0,
      fixture: fixture() }],
  };
  evaluation: EvaluationExportSource = evaluation();

  async readDataset(): Promise<DatasetExportSource> { return this.dataset; }
  async readEvaluation(): Promise<EvaluationExportSource> { return this.evaluation; }
  async readAnnotationRun(): Promise<{ sourceRunId: string; runAttemptCount: number }> {
    return { sourceRunId: RUN, runAttemptCount: 1 };
  }
}

class FakeLangfuseClient implements LangfuseQualityPort {
  datasets: unknown[] = [];
  items: UpsertDatasetItemInput[] = [];
  runItems: unknown[] = [];
  scores: UpsertScoreInput[] = [];
  queueItems: Array<{ queueId: string; objectId: string }> = [];
  abortAfterFirstItem?: AbortController;

  async getTextPrompt(): Promise<never> { throw new Error("unused"); }
  async createTextPrompt(): Promise<never> { throw new Error("unused"); }
  async getOrCreateDataset(input: unknown) { this.datasets.push(input); return { id: "remote-dataset", name: "remote", description: null }; }
  async upsertDatasetItem(input: UpsertDatasetItemInput) {
    this.items.push(input);
    if (this.items.length === 1) this.abortAfterFirstItem?.abort();
    return { id: "remote-item", datasetId: "remote-dataset", datasetName: input.datasetName };
  }
  async linkDatasetRunItem(input: unknown) {
    this.runItems.push(input); return { id: "remote-run-item", datasetRunId: "remote-run", datasetItemId: "item", traceId: TRACE };
  }
  async getOrCreateScoreConfig(input: { name: string; kind: "NUMERIC" | "CATEGORICAL" | "BOOLEAN" }) {
    return { id: "score-config", ...input };
  }
  async upsertScore(input: UpsertScoreInput) { this.scores.push(input); return { id: `score-${this.scores.length}` }; }
  async getOrCreateAnnotationQueue(input: { name: string; scoreConfigIds: string[] }) {
    return { id: "queue-1", name: input.name, description: null, scoreConfigIds: input.scoreConfigIds };
  }
  async addAnnotationQueueItem(input: { queueId: string; objectId: string; objectType: "TRACE" | "OBSERVATION" | "SESSION" }) {
    this.queueItems.push(input); return { id: "queue-item", ...input };
  }
  async listHumanAnnotationScores() {
    return [{ id: "human-score-1", traceId: TRACE, name: "human_review", kind: "CATEGORICAL" as const,
      value: "correct", timestamp: new Date(0).toISOString() }];
  }
  annotationPages: Array<{ scores: Awaited<ReturnType<LangfuseQualityPort["listHumanAnnotationScores"]>>;
    nextCursor?: string }> = [];
  async listHumanAnnotationScorePage() {
    return this.annotationPages.shift() ?? { scores: await this.listHumanAnnotationScores() };
  }
}

class FakeAnnotationStore {
  imports: Array<{ traceLinkId: string; score: Record<string, unknown> }> = [];
  async importScore(_scope: unknown, input: { sourceRunId: string; traceLinkId: string; remoteScoreId: string;
    contentHash: string; score: Record<string, unknown>; actor: { actorType: "service" | "system"; actorId: string } }): Promise<QualityAnnotationImport> {
    this.imports.push(input);
    return { id: CASE, scope: { tenantId: TENANT, integrationId: INTEGRATION }, sourceRunId: input.sourceRunId,
      traceLinkId: input.traceLinkId, remoteScoreId: input.remoteScoreId, contentHash: input.contentHash,
      score: input.score, state: "pending_review", importedBy: input.actor,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), version: 1 };
  }
}

function handlersFor(client: FakeLangfuseClient, sourceReader: QualitySourceReaderPort,
  env: NodeJS.ProcessEnv = {}, annotationStore = new FakeAnnotationStore(),
  judgeResultReader?: { read(db: never, principal: RunPrincipal, judgeRunId: string): Promise<JudgeResult> },
  traceLinks?: QualityTraceLink[],
  enqueueContinuation?: (scope: QualityScope, input: EnqueueQualitySyncJobInput) => Promise<QualitySyncJob>) {
  const trace = traceLink(1, TRACE);
  return createQualitySyncHandlers({ db: {} as never, client, sourceReader,
    traceStore: { listForRun: async () => traceLinks ?? [trace] }, annotationStore,
    targetFingerprint: HASH, env, ...(judgeResultReader ? { judgeResultReader } : {}),
    ...(enqueueContinuation ? { enqueueContinuation } : {}) });
}

function traceLink(runAttempt: number, traceId: string): QualityTraceLink {
  return { id: `trace-link-${runAttempt}`, scope: { tenantId: TENANT, integrationId: INTEGRATION },
    runId: RUN, runAttempt, traceId, externalId: `trace:${runAttempt}`, targetFingerprint: HASH,
    createdAt: new Date(runAttempt).toISOString() };
}

function job(kind: QualitySyncJob["kind"], payload: Record<string, unknown>,
  jobPrincipal: RunPrincipal = principal): QualitySyncJob {
  return { id: CASE, scope: { tenantId: TENANT, integrationId: INTEGRATION }, kind,
    externalId: `${kind}:1`, idempotencyKey: `${kind}:1`, requestHash: HASH, targetFingerprint: HASH,
    payload, principal: jobPrincipal as unknown as Record<string, unknown>, status: "running", attemptCount: 1,
    maxAttempts: 3, maxAgeSeconds: 3600, availableAt: new Date(0).toISOString(), leaseOwner: "worker",
    leaseEpoch: 1, leaseExpiresAt: new Date(1).toISOString(), createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(), version: 1 };
}

function frozenJudgeResult(): JudgeResult {
  return {
    schemaVersion: 1,
    workflow: "eval.judge.v1",
    judgeRunId: JUDGE_RUN,
    sourceRunId: RUN,
    sourceArtifactHash: HASH,
    sourceHash: DATASET_HASH,
    promptVersionHash: FIXTURE_HASH,
    modelVersionHash: LABEL_HASH,
    rubricHash: SCORE_HASH,
    judgments: [{ findingId: HASH, judgment: "supported", evidenceScore: 4,
      actionabilityScore: 3, reason: "The frozen source directly supports this finding." }],
    summary: "The finding is supported.",
  };
}

function fixture() {
  return { schemaVersion: 1 as const, sourceRunId: RUN, platform: "github" as const,
    repository: "owner/repo", pullNumber: 1, baseSha: "base", headSha: "head",
    sourceCreatedAt: new Date(0).toISOString(), input: { apiKey: "should-redact" }, collected: {},
    coverage: { status: "complete" as const, reasonCodes: [] as [], repositoryRead: {
      status: "complete" as const, reasonCodes: [], availablePaths: ["src/a.ts"] } }, ci: {},
    files: [{ path: "src/a.ts", kind: "source" as const, content: "const answer = 42;",
      contentHash: HASH, sizeBytes: 18 }], fixtureHash: FIXTURE_HASH, totalBytes: 18 };
}

function evaluation(): EvaluationExportSource {
  return { evaluationId: EVALUATION, manifestHash: HASH, datasetId: DATASET,
    datasetManifestHash: DATASET_HASH, datasetVersion: 2, split: "validation", status: "succeeded",
    counts: { planned: 1, completed: 1, failed: 0, scored: 1 }, aggregateMetrics: { completeMatrix: true },
    results: [{ resultId: RESULT, childRunId: RUN, caseId: CASE, variant: "candidate", repetition: 1,
      fixtureHash: FIXTURE_HASH, labelSetHash: LABEL_HASH, scoreHash: SCORE_HASH,
      score: { schemaVersion: 1, expected: 1, predicted: 1, truePositive: 1, falsePositive: 0,
        falseNegative: 0, precision: 1, recall: 1, f1: 1, severityWeightedF1: 1,
        highFalsePositives: 0, highFalseNegatives: 0, safetyRegression: false, analysisStatus: "complete" },
      expectedHashes: { workflow: HASH, prompt: HASH, model: HASH, tool: HASH, policy: HASH,
        runtime: HASH, verifier: HASH } }], };
}
