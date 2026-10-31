import type { RuntimeDatabase } from "../../agent-runtime/postgres/database.js";
import { requireRunPermission, RUN_PERMISSIONS, type RunPermission,
  type RunPrincipal } from "../../agent-runtime/runs/control-contracts.js";
import { fingerprint } from "../../agent-runtime/versions.js";
import { redactDatasetJson } from "../../evolution/datasets/fixture.js";
import type { JudgeResult } from "../evaluators/contracts.js";
import { judgeScores, readJudgeResult } from "../evaluators/store.js";
import { deterministicLangfuseId } from "../langfuse/client.js";
import type { LangfuseQualityPort, UpsertScoreInput } from "../langfuse/contracts.js";
import type { EnqueueQualitySyncJobInput, QualityAnnotationImport, QualityScope, QualitySyncJob,
  QualitySyncJobKind, QualityTraceLink } from "../storage/contracts.js";
import type { QualitySourceReaderPort, EvaluationExportSource } from "./source-reader.js";
import { QualitySourceReader } from "./source-reader.js";

const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_MAX_ITEM_BYTES = 1024 * 1024;
const MAX_TRACE_LINKS = 500;

export type QualityExportSyncKind = Exclude<QualitySyncJobKind, "prompt_pull">;
export type QualitySyncHandler = (job: QualitySyncJob,
  context?: { signal: AbortSignal }) => Promise<Record<string, unknown>>;

interface TraceStorePort {
  listForRun(scope: { tenantId: string; integrationId: string }, runId: string): Promise<QualityTraceLink[]>;
}

interface AnnotationStorePort {
  importScore(scope: { tenantId: string; integrationId: string }, input: {
    sourceRunId: string;
    traceLinkId: string;
    remoteScoreId: string;
    contentHash: string;
    score: Record<string, unknown>;
    actor: { actorType: "service" | "system"; actorId: string };
  }): Promise<QualityAnnotationImport>;
}

interface JudgeResultReaderPort {
  read(db: RuntimeDatabase, principal: RunPrincipal, judgeRunId: string): Promise<JudgeResult>;
}

export interface QualitySyncHandlerDependencies {
  db: RuntimeDatabase;
  client: LangfuseQualityPort;
  traceStore: TraceStorePort;
  annotationStore: AnnotationStorePort;
  targetFingerprint: string;
  env: NodeJS.ProcessEnv;
  sourceReader?: QualitySourceReaderPort;
  judgeResultReader?: JudgeResultReaderPort;
  enqueueContinuation?: (scope: QualityScope, input: EnqueueQualitySyncJobInput) => Promise<QualitySyncJob>;
}

export class QualitySyncExportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "QualitySyncExportError";
  }
}

export function createQualitySyncHandlers(
  dependencies: QualitySyncHandlerDependencies,
): Record<QualityExportSyncKind, QualitySyncHandler> {
  if (!HASH.test(dependencies.targetFingerprint)) throw new QualitySyncExportError("QUALITY_TARGET_INVALID");
  const sourceReader = dependencies.sourceReader ?? new QualitySourceReader(dependencies.db);
  const judgeResultReader = dependencies.judgeResultReader ?? { read: readJudgeResult };
  const maxItemBytes = readMaxItemBytes(dependencies.env);
  const actorId = dependencies.env.QUALITY_LANGFUSE_SYNC_ACTOR_ID?.trim() || "langfuse-quality-sync";
  if (actorId.length > 240) throw new QualitySyncExportError("QUALITY_SYNC_ACTOR_INVALID");

  const datasetExport: QualitySyncHandler = async (job, context) => {
    context?.signal.throwIfAborted();
    assertJobKind(job, "dataset_export");
    const principal = principalForJob(job, dependencies.targetFingerprint);
    const payload = datasetPayload(job.payload);
    assertPayloadPrincipal(payload.principal, principal);
    const source = await sourceReader.readDataset(principal, payload);
    const datasetName = remoteDatasetName(principal, source.datasetId, source.manifestHash, source.split);
    await dependencies.client.getOrCreateDataset({
      name: datasetName,
      description: `PR Agent ${source.split} evaluation dataset`,
      metadata: {
        schemaVersion: 1,
        tenantId: principal.tenantId,
        integrationId: principal.integrationId,
        sourceDatasetId: source.datasetId,
        sourceDatasetVersion: source.datasetVersion,
        sourceManifestHash: source.manifestHash,
        split: source.split,
        counts: source.counts,
      },
    }, { signal: context?.signal });
    let exported = 0;
    for (const item of source.cases) {
      context?.signal.throwIfAborted();
      const sanitizedFixture = redactDatasetJson(item.fixture);
      const sanitizedLabels = redactDatasetJson(item.labelSet);
      const metadata = {
        schemaVersion: 1,
        tenantId: principal.tenantId,
        integrationId: principal.integrationId,
        sourceDatasetId: source.datasetId,
        sourceDatasetVersion: source.datasetVersion,
        sourceManifestHash: source.manifestHash,
        split: source.split,
        ordinal: item.ordinal,
        caseId: item.caseId,
        sourceRunId: item.sourceRunId,
        fixtureHash: item.fixtureHash,
        labelProvenance: {
          kind: "trusted_review_label_set",
          source: "postgres_trusted_review_label_sets",
          trusted: true,
          labelSetId: item.labelSetId,
          labelSetHash: item.labelSetHash,
        },
      };
      assertBoundedItem({ input: sanitizedFixture, expectedOutput: sanitizedLabels, metadata }, maxItemBytes);
      await dependencies.client.upsertDatasetItem({
        datasetName,
        stableKey: datasetItemStableKey(principal, source.datasetId, source.manifestHash, source.split,
          item.caseId, item.fixtureHash, item.labelSetHash),
        input: sanitizedFixture,
        expectedOutput: sanitizedLabels,
        metadata,
        sourceTraceId: undefined,
      }, { signal: context?.signal });
      exported += 1;
    }
    return { datasetName, exported, split: source.split, sourceManifestHash: source.manifestHash,
      holdoutCount: source.counts.holdout };
  };

  const exportEvaluation = async (job: QualitySyncJob, mode: "links-and-scores" | "scores-only",
    context?: { signal: AbortSignal }) => {
    context?.signal.throwIfAborted();
    assertJobKind(job, mode === "links-and-scores" ? "evaluation_export" : "scores_export");
    const principal = principalForJob(job, dependencies.targetFingerprint);
    const payload = evaluationPayload(job.payload);
    assertPayloadPrincipal(payload.principal, principal);
    const source = await sourceReader.readEvaluation(principal, payload);
    if (source.split === "holdout") {
      return { evaluationId: source.evaluationId, split: source.split, remoteWrites: 0,
        aggregateOnly: true, counts: source.counts };
    }
    if (source.status !== "succeeded") throw new QualitySyncExportError("QUALITY_EVALUATION_NOT_COMPLETE");
    const result = await exportEvaluationResults(dependencies, principal, source, mode, context);
    return { evaluationId: source.evaluationId, split: source.split, counts: source.counts, ...result };
  };

  const exportScores: QualitySyncHandler = async (job, context) => {
    context?.signal.throwIfAborted();
    assertJobKind(job, "scores_export");
    const principal = principalForJob(job, dependencies.targetFingerprint);
    if (Object.hasOwn(job.payload, "judgeRunId")) {
      const payload = judgeScoresPayload(job.payload);
      assertPayloadPrincipal(payload.principal, principal);
      requireRunPermission(principal, "runs:read");
      requireRunPermission(principal, "quality:sync:execute");
      requireRunPermission(principal, "quality:evaluators:run");
      const judged = await judgeResultReader.read(dependencies.db, principal, payload.judgeRunId);
      const trace = await latestScopedTraceLink(dependencies.traceStore, principal, payload.judgeRunId,
        dependencies.targetFingerprint);
      if (!trace) throw new QualitySyncExportError("QUALITY_JUDGE_TRACE_LINK_UNAVAILABLE");
      const metrics = judgeScores(judged);
      for (const metric of metrics) {
        context?.signal.throwIfAborted();
        const common = {
          stableKey: metric.stableKey,
          traceId: trace.traceId,
          name: metric.name,
          comment: metric.comment,
          metadata: {
            schemaVersion: 1,
            judgeRunId: judged.judgeRunId,
            sourceRunId: judged.sourceRunId,
            sourceArtifactHash: judged.sourceArtifactHash,
            sourceHash: judged.sourceHash,
            rubricHash: judged.rubricHash,
            promptVersionHash: judged.promptVersionHash,
            modelVersionHash: judged.modelVersionHash,
            trustedLabel: false,
          },
        };
        const input: UpsertScoreInput = metric.kind === "CATEGORICAL"
          ? { ...common, kind: "CATEGORICAL", value: String(metric.value) }
          : { ...common, kind: "NUMERIC", value: Number(metric.value) };
        await dependencies.client.upsertScore(input, { signal: context?.signal });
      }
      return { judgeRunId: judged.judgeRunId, sourceRunId: judged.sourceRunId,
        traceId: trace.traceId, scoresExported: metrics.length, trustedLabel: false };
    }
    return exportEvaluation(job, "scores-only", context);
  };

  const annotationQueue: QualitySyncHandler = async (job, context) => {
    context?.signal.throwIfAborted();
    assertJobKind(job, "annotation_queue");
    const principal = principalForJob(job, dependencies.targetFingerprint);
    const payload = annotationPayload(job.payload);
    assertPayloadPrincipal(payload.principal, principal);
    await sourceReader.readAnnotationRun(principal, payload.sourceRunId);
    const links = await scopedTraceLinks(dependencies.traceStore, principal, payload.sourceRunId,
      dependencies.targetFingerprint);
    const scoreConfig = await dependencies.client.getOrCreateScoreConfig({
      name: annotationScoreConfigName(principal),
      kind: "CATEGORICAL",
      description: "Human review of PR Agent output",
      categories: [
        { label: "incorrect", value: 0 },
        { label: "correct", value: 1 },
        { label: "uncertain", value: -1 },
      ],
    }, { signal: context?.signal });
    const queue = await dependencies.client.getOrCreateAnnotationQueue({
      name: annotationQueueName(principal),
      description: "PR Agent human annotation queue",
      scoreConfigIds: [scoreConfig.id],
    }, { signal: context?.signal });
    for (const link of links) {
      context?.signal.throwIfAborted();
      await dependencies.client.addAnnotationQueueItem({ queueId: queue.id, objectId: link.traceId,
        objectType: "TRACE" }, { signal: context?.signal });
    }
    return { sourceRunId: payload.sourceRunId, queueId: queue.id, scoreConfigId: scoreConfig.id,
      enqueued: links.length };
  };

  const annotationPull: QualitySyncHandler = async (job, context) => {
    context?.signal.throwIfAborted();
    assertJobKind(job, "annotation_pull");
    const principal = principalForJob(job, dependencies.targetFingerprint);
    const payload = annotationPayload(job.payload);
    assertPayloadPrincipal(payload.principal, principal);
    await sourceReader.readAnnotationRun(principal, payload.sourceRunId);
    const links = await scopedTraceLinks(dependencies.traceStore, principal, payload.sourceRunId,
      dependencies.targetFingerprint);
    if (links.length === 0) return { sourceRunId: payload.sourceRunId, importedPending: 0,
      inspected: 0, continuationEnqueued: false };
    if (payload.traceIndex >= links.length) throw new QualitySyncExportError("QUALITY_ANNOTATION_CURSOR_INVALID");
    const link = links[payload.traceIndex]!;
    const scoreConfig = await dependencies.client.getOrCreateScoreConfig({
      name: annotationScoreConfigName(principal), kind: "CATEGORICAL",
      description: "Human review of PR Agent output",
      categories: [{ label: "incorrect", value: 0 }, { label: "correct", value: 1 },
        { label: "uncertain", value: -1 }],
    }, { signal: context?.signal });
    const queue = await dependencies.client.getOrCreateAnnotationQueue({
      name: annotationQueueName(principal), description: "PR Agent human annotation queue",
      scoreConfigIds: [scoreConfig.id],
    }, { signal: context?.signal });
    const page = await dependencies.client.listHumanAnnotationScorePage({ traceId: link.traceId,
      queueId: queue.id, configId: scoreConfig.id, cursor: payload.scoreCursor, limit: 100 },
    { signal: context?.signal });
    let imported = 0;
    for (const score of page.scores) {
      context?.signal.throwIfAborted();
      const sanitized = redactDatasetJson({ schemaVersion: 1, provenance: "langfuse_human_annotation",
        trustedLabel: false, ...score }) as Record<string, unknown>;
      const annotation = await dependencies.annotationStore.importScore({ tenantId: principal.tenantId,
        integrationId: principal.integrationId }, { sourceRunId: payload.sourceRunId, traceLinkId: link.id,
        remoteScoreId: score.id, contentHash: fingerprint(sanitized), score: sanitized,
        actor: { actorType: "system", actorId } });
      if (annotation.state === "pending_review") imported += 1;
    }
    if (page.nextCursor !== undefined
        && (page.nextCursor === payload.scoreCursor || payload.pageCount >= 10_000)) {
      throw new QualitySyncExportError("QUALITY_ANNOTATION_CURSOR_STALLED");
    }
    const nextCursor = page.nextCursor
      ? { traceIndex: payload.traceIndex, scoreCursor: page.nextCursor, pageCount: payload.pageCount + 1 }
      : payload.traceIndex + 1 < links.length ? { traceIndex: payload.traceIndex + 1, pageCount: 0 } : undefined;
    if (nextCursor) {
      if (!dependencies.enqueueContinuation) {
        throw new QualitySyncExportError("QUALITY_ANNOTATION_CONTINUATION_UNAVAILABLE");
      }
      context?.signal.throwIfAborted();
      const continuationPayload = { sourceRunId: payload.sourceRunId, principal: job.principal,
        cursor: nextCursor };
      const continuationHash = fingerprint(continuationPayload);
      await dependencies.enqueueContinuation(job.scope, { kind: "annotation_pull",
        externalId: `annotation-pull:${job.id}:${continuationHash.slice(0, 24)}`,
        idempotencyKey: `annotation-pull:${job.id}:${continuationHash.slice(0, 24)}`,
        requestHash: continuationHash, targetFingerprint: job.targetFingerprint,
        payload: continuationPayload, principal: job.principal, maxAttempts: job.maxAttempts,
        maxAgeSeconds: job.maxAgeSeconds });
    }
    return { sourceRunId: payload.sourceRunId, importedPending: imported, inspected: page.scores.length,
      continuationEnqueued: Boolean(nextCursor) };
  };

  return {
    dataset_export: datasetExport,
    evaluation_export: (job, context) => exportEvaluation(job, "links-and-scores", context),
    scores_export: exportScores,
    annotation_queue: annotationQueue,
    annotation_pull: annotationPull,
  };
}

async function exportEvaluationResults(
  dependencies: QualitySyncHandlerDependencies,
  principal: RunPrincipal,
  source: EvaluationExportSource,
  mode: "links-and-scores" | "scores-only",
  context?: { signal: AbortSignal },
): Promise<Record<string, unknown>> {
  const scope = { tenantId: principal.tenantId, integrationId: principal.integrationId };
  const runNames = new Set<string>();
  const traces = new Map<string, QualityTraceLink>();
  for (const result of source.results) {
    if (traces.has(result.childRunId)) continue;
    const trace = await latestScopedTraceLink(dependencies.traceStore, principal, result.childRunId,
      dependencies.targetFingerprint);
    if (!trace) throw new QualitySyncExportError("QUALITY_TRACE_LINK_UNAVAILABLE");
    traces.set(result.childRunId, trace);
  }
  let linked = 0;
  let scores = 0;
  for (const result of source.results) {
    context?.signal.throwIfAborted();
    const trace = traces.get(result.childRunId)!;
    const runName = remoteEvaluationRunName(source, result.variant, result.repetition);
    runNames.add(runName);
    if (mode === "links-and-scores") {
      const datasetItemId = deterministicLangfuseId("dataset-item",
        remoteDatasetName(principal, source.datasetId, source.datasetManifestHash, source.split),
        datasetItemStableKey(principal, source.datasetId, source.datasetManifestHash, source.split,
          result.caseId, result.fixtureHash, result.labelSetHash));
      await dependencies.client.linkDatasetRunItem({
        runName,
        runDescription: `PR Agent evaluation ${source.evaluationId}`,
        datasetItemId,
        traceId: trace.traceId,
        metadata: { schemaVersion: 1, evaluationId: source.evaluationId, evaluationManifestHash: source.manifestHash,
          datasetManifestHash: source.datasetManifestHash, variant: result.variant,
          repetition: result.repetition, scoreHash: result.scoreHash, expectedHashes: result.expectedHashes },
      }, { signal: context?.signal });
      linked += 1;
    }
    for (const metric of scoreMetrics(result.score)) {
      context?.signal.throwIfAborted();
      const common = {
        stableKey: `${source.evaluationId}:${source.manifestHash}:${result.resultId}:${result.scoreHash}:${metric.name}`,
        traceId: trace.traceId,
        name: metric.name,
        metadata: { schemaVersion: 1, evaluationId: source.evaluationId, evaluationManifestHash: source.manifestHash,
          resultId: result.resultId, variant: result.variant, repetition: result.repetition,
          scoreHash: result.scoreHash, expectedHashes: result.expectedHashes },
      };
      const input: UpsertScoreInput = metric.kind === "BOOLEAN"
        ? { ...common, kind: "BOOLEAN", value: metric.value as boolean }
        : { ...common, kind: "NUMERIC", value: metric.value as number };
      await dependencies.client.upsertScore(input, { signal: context?.signal });
      scores += 1;
    }
  }
  return { runNames: [...runNames].sort(), runCount: runNames.size, linked, scoresExported: scores };
}

function scoreMetrics(score: EvaluationExportSource["results"][number]["score"]): Array<{
  name: string;
  kind: "NUMERIC" | "BOOLEAN";
  value: number | boolean;
}> {
  return [
    { name: "eval_precision", kind: "NUMERIC", value: score.precision },
    { name: "eval_recall", kind: "NUMERIC", value: score.recall },
    { name: "eval_f1", kind: "NUMERIC", value: score.f1 },
    { name: "eval_severity_weighted_f1", kind: "NUMERIC", value: score.severityWeightedF1 },
    { name: "eval_safety_regression", kind: "BOOLEAN", value: score.safetyRegression },
    { name: "eval_high_false_positives", kind: "NUMERIC", value: score.highFalsePositives },
    { name: "eval_high_false_negatives", kind: "NUMERIC", value: score.highFalseNegatives },
  ];
}

async function scopedTraceLinks(
  store: TraceStorePort,
  principal: RunPrincipal,
  runId: string,
  targetFingerprint: string,
): Promise<QualityTraceLink[]> {
  const links = await store.listForRun({ tenantId: principal.tenantId, integrationId: principal.integrationId }, runId);
  const scoped = links.filter((link) => link.targetFingerprint === targetFingerprint);
  if (scoped.length > MAX_TRACE_LINKS) throw new QualitySyncExportError("QUALITY_TRACE_LINK_LIMIT");
  return scoped;
}

async function latestScopedTraceLink(
  store: TraceStorePort,
  principal: RunPrincipal,
  runId: string,
  targetFingerprint: string,
): Promise<QualityTraceLink | undefined> {
  const links = await scopedTraceLinks(store, principal, runId, targetFingerprint);
  return links.reduce<QualityTraceLink | undefined>((latest, link) =>
    !latest || link.runAttempt > latest.runAttempt ? link : latest, undefined);
}

function principalForJob(job: QualitySyncJob, targetFingerprint: string): RunPrincipal {
  if (job.targetFingerprint !== targetFingerprint) throw new QualitySyncExportError("QUALITY_TARGET_CHANGED");
  const principal = parsePrincipal(job.principal);
  if (principal.tenantId !== job.scope.tenantId || principal.integrationId !== job.scope.integrationId) {
    throw new QualitySyncExportError("QUALITY_PRINCIPAL_SCOPE_MISMATCH");
  }
  return principal;
}

function assertJobKind(job: QualitySyncJob, expected: QualityExportSyncKind): void {
  if (job.kind !== expected) throw new QualitySyncExportError("QUALITY_JOB_KIND_MISMATCH");
}

function parsePrincipal(value: Record<string, unknown>): RunPrincipal {
  const permissions = value.permissions;
  if (typeof value.subjectId !== "string" || value.subjectId.length < 1 || value.subjectId.length > 512
      || (value.actorType !== "user" && value.actorType !== "service")
      || typeof value.tenantId !== "string" || !UUID.test(value.tenantId)
      || typeof value.integrationId !== "string" || !UUID.test(value.integrationId)
      || !Array.isArray(permissions) || permissions.some((permission) => typeof permission !== "string"
        || !RUN_PERMISSIONS.includes(permission as RunPermission))) {
    throw new QualitySyncExportError("QUALITY_PRINCIPAL_INVALID");
  }
  return { subjectId: value.subjectId, actorType: value.actorType, tenantId: value.tenantId,
    integrationId: value.integrationId, permissions: [...new Set(permissions as RunPermission[])] };
}

function assertPayloadPrincipal(value: unknown, expected: RunPrincipal): void {
  if (!value || typeof value !== "object" || fingerprint(normalizePrincipal(parsePrincipal(value as Record<string, unknown>)))
      !== fingerprint(normalizePrincipal(expected))) {
    throw new QualitySyncExportError("QUALITY_PRINCIPAL_SNAPSHOT_MISMATCH");
  }
}

function normalizePrincipal(principal: RunPrincipal): Record<string, unknown> {
  return { ...principal, permissions: [...principal.permissions].sort() };
}

function datasetPayload(payload: Record<string, unknown>): { datasetId: string; split: "development" | "validation";
  expectedManifestHash: string; principal: unknown } {
  if (typeof payload.datasetId !== "string" || !UUID.test(payload.datasetId)
      || (payload.split !== "development" && payload.split !== "validation")
      || typeof payload.expectedManifestHash !== "string" || !HASH.test(payload.expectedManifestHash)) {
    throw new QualitySyncExportError("QUALITY_DATASET_PAYLOAD_INVALID");
  }
  return { datasetId: payload.datasetId, split: payload.split,
    expectedManifestHash: payload.expectedManifestHash, principal: payload.principal };
}

function evaluationPayload(payload: Record<string, unknown>): { evaluationId: string; expectedManifestHash: string;
  principal: unknown } {
  if (typeof payload.evaluationId !== "string" || !UUID.test(payload.evaluationId)
      || typeof payload.expectedManifestHash !== "string" || !HASH.test(payload.expectedManifestHash)) {
    throw new QualitySyncExportError("QUALITY_EVALUATION_PAYLOAD_INVALID");
  }
  return { evaluationId: payload.evaluationId, expectedManifestHash: payload.expectedManifestHash,
    principal: payload.principal };
}

function judgeScoresPayload(payload: Record<string, unknown>): { judgeRunId: string; principal: unknown } {
  if (typeof payload.judgeRunId !== "string" || !UUID.test(payload.judgeRunId)
      || Object.keys(payload).some((key) => key !== "judgeRunId" && key !== "principal")) {
    throw new QualitySyncExportError("QUALITY_JUDGE_SCORES_PAYLOAD_INVALID");
  }
  return { judgeRunId: payload.judgeRunId, principal: payload.principal };
}

function annotationPayload(payload: Record<string, unknown>): { sourceRunId: string; principal: unknown;
  traceIndex: number; pageCount: number; scoreCursor?: string } {
  if (typeof payload.sourceRunId !== "string" || !UUID.test(payload.sourceRunId)) {
    throw new QualitySyncExportError("QUALITY_ANNOTATION_PAYLOAD_INVALID");
  }
  const cursor = payload.cursor;
  if (cursor !== undefined) {
    if (!cursor || typeof cursor !== "object") {
      throw new QualitySyncExportError("QUALITY_ANNOTATION_CURSOR_INVALID");
    }
    const candidate = cursor as { traceIndex?: unknown; pageCount?: unknown; scoreCursor?: unknown };
    if (!Number.isSafeInteger(candidate.traceIndex) || Number(candidate.traceIndex) < 0
        || !Number.isSafeInteger(candidate.pageCount) || Number(candidate.pageCount) < 0
        || Number(candidate.pageCount) > 10_000
        || (candidate.scoreCursor !== undefined && (typeof candidate.scoreCursor !== "string"
          || !candidate.scoreCursor || candidate.scoreCursor.length > 1_024))) {
      throw new QualitySyncExportError("QUALITY_ANNOTATION_CURSOR_INVALID");
    }
  }
  const parsed = cursor as { traceIndex: number; pageCount: number; scoreCursor?: string } | undefined;
  return { sourceRunId: payload.sourceRunId, principal: payload.principal,
    traceIndex: parsed?.traceIndex ?? 0, pageCount: parsed?.pageCount ?? 0,
    ...(parsed?.scoreCursor ? { scoreCursor: parsed.scoreCursor } : {}) };
}

function datasetItemStableKey(principal: RunPrincipal, datasetId: string, manifestHash: string,
  split: string, caseId: string, fixtureHash: string, labelSetHash: string): string {
  return [principal.tenantId, principal.integrationId, datasetId, manifestHash, split, caseId,
    fixtureHash, labelSetHash].join(":");
}

function remoteDatasetName(principal: RunPrincipal, datasetId: string, manifestHash: string, split: string): string {
  return `pr-agent/${principal.tenantId}/${principal.integrationId}/datasets/${datasetId}/${manifestHash.slice(0, 16)}/${split}`;
}

function remoteEvaluationRunName(source: EvaluationExportSource, variant: string, repetition: number): string {
  return `pr-agent/evaluations/${source.evaluationId}/${source.manifestHash.slice(0, 16)}/${variant}/r${repetition}`;
}

function annotationScoreConfigName(principal: RunPrincipal): string {
  return `pr_${principal.tenantId.slice(0, 8)}_${principal.integrationId.slice(0, 8)}_human`;
}

function annotationQueueName(principal: RunPrincipal): string {
  return `pr-agent/${principal.tenantId}/${principal.integrationId}/human-review`;
}

function assertBoundedItem(value: unknown, maxBytes: number): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new QualitySyncExportError("QUALITY_DATASET_ITEM_OVERSIZED");
  }
}

function readMaxItemBytes(env: NodeJS.ProcessEnv): number {
  const raw = env.QUALITY_LANGFUSE_MAX_ITEM_BYTES?.trim();
  if (!raw) return DEFAULT_MAX_ITEM_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1024 || value > 10 * 1024 * 1024) {
    throw new QualitySyncExportError("QUALITY_MAX_ITEM_BYTES_INVALID");
  }
  return value;
}
