import { Inject, Injectable } from "@nestjs/common";

import { requireRunPermission, RunControlError, type RunPrincipal } from "../../agent-runtime/runs/control-contracts.js";
import { getAgentRuntimeServices } from "../../agent-runtime/runtime/services.js";
import type { RuntimeDatabase } from "../../agent-runtime/postgres/database.js";
import { fingerprint } from "../../agent-runtime/versions.js";
import { PgEvolutionFeedbackStore } from "../../evolution/feedback/store.js";
import { resolveQualityConfiguration } from "../../quality/config.js";
import { admitJudgeRun, readJudgeResult } from "../../quality/evaluators/index.js";
import { MANAGED_PROMPT_CATALOG } from "../../quality/prompts/catalog.js";
import { PgQualityAnnotationStore, PgQualityPromptStore, PgQualitySyncJobStore,
  QualityLeaseLostError, QualityStorageConflictError, QualityStorageNotFoundError,
  type EnqueueQualitySyncJobInput, type QualityScope, type QualitySyncJobKind } from "../../quality/storage/index.js";
import { RunApiContextService } from "../common/run-api-context.service.js";
import {
  annotationInboxQuerySchema, annotationPromotionSchema, annotationReviewSchema, annotationSyncSchema,
  datasetExportSchema, evaluationExportSchema, promptActivationSchema, promptPullSchema, scoresExportSchema,
  qualityCommandKeySchema, qualityIdSchema, qualityJudgeRequestSchema, syncJobListQuerySchema, syncJobRetrySchema,
} from "./input.js";

@Injectable()
export class QualityService {
  constructor(@Inject(RunApiContextService) private readonly context: RunApiContextService) {}

  async listPrompts(principal: RunPrincipal) {
    requireRunPermission(principal, "quality:prompts:read");
    await this.assertEnabled(principal);
    return this.protect(async () => new PgQualityPromptStore((await getAgentRuntimeServices()).db).list(scope(principal)));
  }

  async pullPrompt(principal: RunPrincipal, key: unknown, body: unknown) {
    requireRunPermission(principal, "quality:sync:execute");
    const configuration = await this.assertEnabled(principal);
    const input = promptPullSchema.parse(body); const commandKey = qualityCommandKeySchema.parse(key);
    if (input.seed) {
      const definition = MANAGED_PROMPT_CATALOG[input.promptKey];
      if (input.remoteName !== definition.name || input.version !== 1) {
        throw new RunControlError("QUALITY_SEED_INVALID", 422,
          "Seed pulls require the catalog prompt name and version 1");
      }
    }
    return this.enqueue(principal, configuration.targetFingerprint, "prompt_pull", commandKey, input);
  }

  async activatePrompt(principal: RunPrincipal, promptVersionId: string, key: unknown, body: unknown) {
    requireRunPermission(principal, "quality:prompts:approve");
    const configuration = await this.assertEnabled(principal);
    const input = promptActivationSchema.parse(body); const commandKey = qualityCommandKeySchema.parse(key);
    const id = qualityIdSchema.parse(promptVersionId);
    return this.protect(async () => new PgQualityPromptStore((await getAgentRuntimeServices()).db).activate(scope(principal), {
      promptVersionId: id, promptKey: input.promptKey, expectedContentHash: input.expectedContentHash,
      expectedSourceFingerprint: input.expectedSourceFingerprint, targetFingerprint: configuration.targetFingerprint,
      commandKey, actor: actor(principal),
    }));
  }

  async exportDataset(principal: RunPrincipal, key: unknown, body: unknown) {
    return this.enqueueParsed(principal, key, "dataset_export", datasetExportSchema.parse(body));
  }

  async exportEvaluation(principal: RunPrincipal, key: unknown, body: unknown) {
    return this.enqueueParsed(principal, key, "evaluation_export", evaluationExportSchema.parse(body));
  }

  async exportScores(principal: RunPrincipal, key: unknown, body: unknown) {
    return this.enqueueParsed(principal, key, "scores_export", scoresExportSchema.parse(body));
  }

  async queueAnnotation(principal: RunPrincipal, key: unknown, body: unknown) {
    return this.enqueueParsed(principal, key, "annotation_queue", annotationSyncSchema.parse(body));
  }

  async pullAnnotations(principal: RunPrincipal, key: unknown, body: unknown) {
    return this.enqueueParsed(principal, key, "annotation_pull", annotationSyncSchema.parse(body));
  }

  async listInbox(principal: RunPrincipal, query: unknown) {
    requireRunPermission(principal, "quality:annotations:review");
    await this.assertEnabled(principal);
    const filter = annotationInboxQuerySchema.parse(query);
    return this.protect(async () => new PgQualityAnnotationStore((await getAgentRuntimeServices()).db)
      .list(scope(principal), filter));
  }

  async rejectAnnotation(principal: RunPrincipal, annotationId: string, body: unknown) {
    requireRunPermission(principal, "quality:annotations:review");
    await this.assertEnabled(principal);
    const input = annotationReviewSchema.parse(body); const id = qualityIdSchema.parse(annotationId);
    return this.protect(async () => new PgQualityAnnotationStore((await getAgentRuntimeServices()).db)
      .review(scope(principal), { annotationId: id, expectedContentHash: input.expectedContentHash,
        decision: "rejected", reviewer: actor(principal),
        commandKey: annotationReviewCommand(id, input.expectedContentHash, "rejected") }));
  }

  async promoteAnnotation(principal: RunPrincipal, annotationId: string, body: unknown) {
    requireRunPermission(principal, "quality:annotations:review");
    if (principal.actorType !== "user") {
      throw new RunControlError("QUALITY_HUMAN_REVIEW_REQUIRED", 403,
        "Imported annotations require an authenticated human reviewer");
    }
    await this.assertEnabled(principal);
    const input = annotationPromotionSchema.parse(body); const id = qualityIdSchema.parse(annotationId);
    return this.protect(async () => promoteQualityAnnotation(
      (await getAgentRuntimeServices()).db, principal, id, input));
  }

  async listJobs(principal: RunPrincipal, query: unknown) {
    requireRunPermission(principal, "quality:sync:read"); await this.assertEnabled(principal);
    return this.protect(async () => new PgQualitySyncJobStore((await getAgentRuntimeServices()).db)
      .list(scope(principal), syncJobListQuerySchema.parse(query)));
  }

  async readJob(principal: RunPrincipal, jobId: string) {
    requireRunPermission(principal, "quality:sync:read"); await this.assertEnabled(principal);
    return this.protect(async () => new PgQualitySyncJobStore((await getAgentRuntimeServices()).db)
      .read(scope(principal), qualityIdSchema.parse(jobId)));
  }

  async retryJob(principal: RunPrincipal, jobId: string, key: unknown, body: unknown) {
    requireRunPermission(principal, "quality:sync:execute"); await this.assertEnabled(principal);
    const input = syncJobRetrySchema.parse(body); const commandKey = qualityCommandKeySchema.parse(key);
    return this.protect(async () => new PgQualitySyncJobStore((await getAgentRuntimeServices()).db)
      .retry(scope(principal), { jobId: qualityIdSchema.parse(jobId), expectedVersion: input.expectedVersion, commandKey }));
  }

  async admitJudge(principal: RunPrincipal, key: unknown, body: unknown) {
    requireRunPermission(principal, "quality:evaluators:run");
    await this.assertEnabled(principal);
    const services = await getAgentRuntimeServices(); const binding = await this.context.binding(principal);
    return admitJudgeRun({ db: services.db, principal, binding,
      commandKey: qualityCommandKeySchema.parse(key), request: qualityJudgeRequestSchema.parse(body) });
  }

  async readJudge(principal: RunPrincipal, runId: string) {
    requireRunPermission(principal, "quality:evaluators:run"); await this.assertEnabled(principal);
    return readJudgeResult((await getAgentRuntimeServices()).db, principal, qualityIdSchema.parse(runId));
  }

  private async enqueueParsed(principal: RunPrincipal, key: unknown, kind: QualitySyncJobKind,
    payload: Record<string, unknown>) {
    requireRunPermission(principal, "quality:sync:execute");
    const configuration = await this.assertEnabled(principal);
    return this.enqueue(principal, configuration.targetFingerprint, kind, qualityCommandKeySchema.parse(key), payload);
  }

  private async enqueue(principal: RunPrincipal, targetFingerprint: string, kind: QualitySyncJobKind,
    commandKey: string, input: Record<string, unknown>) {
    const job = buildQualitySyncJobInput(principal, targetFingerprint, kind, commandKey, input);
    return this.protect(async () => new PgQualitySyncJobStore((await getAgentRuntimeServices()).db)
      .enqueue(scope(principal), job));
  }

  private async assertEnabled(principal: RunPrincipal): Promise<{ targetFingerprint: string }> {
    const configuration = resolveQualityConfiguration(process.env);
    if (!configuration.enabled || !configuration.targetFingerprint) {
      throw new RunControlError("QUALITY_DISABLED", 503, "Langfuse quality workflows are disabled");
    }
    await this.context.binding(principal);
    return { targetFingerprint: configuration.targetFingerprint };
  }

  private async protect<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) {
      if (error instanceof QualityStorageConflictError || error instanceof QualityLeaseLostError) {
        throw new RunControlError("QUALITY_CONFLICT", 409, error.message);
      }
      if (error instanceof QualityStorageNotFoundError) {
        throw new RunControlError("QUALITY_NOT_FOUND", 404, "Quality resource was not found");
      }
      throw error;
    }
  }
}

type AnnotationPromotionInput = ReturnType<typeof annotationPromotionSchema.parse>;

export async function promoteQualityAnnotation(db: RuntimeDatabase, principal: RunPrincipal,
  annotationId: string, input: AnnotationPromotionInput) {
  if (principal.actorType !== "user") {
    throw new RunControlError("QUALITY_HUMAN_REVIEW_REQUIRED", 403,
      "Imported annotations require an authenticated human reviewer");
  }
  const inbox = new PgQualityAnnotationStore(db); const feedback = new PgEvolutionFeedbackStore(db);
  const reviewScope = scope(principal); const reviewer = actor(principal);
  const commandKey = annotationReviewCommand(annotationId, input.expectedContentHash, "promoted");
  return db.transaction(principal.tenantId, async (client) => {
    const imported = await inbox.lockForReviewInTransaction(client, reviewScope, annotationId);
    const exactReplay = imported.state === "promoted" && imported.contentHash === input.expectedContentHash
      && imported.reviewCommandKey === commandKey
      && imported.reviewedBy?.actorType === reviewer.actorType
      && imported.reviewedBy.actorId === reviewer.actorId;
    if (imported.contentHash !== input.expectedContentHash
        || (imported.state !== "pending_review" && !exactReplay)) {
      throw new QualityStorageConflictError("Imported annotation no longer matches the pending content");
    }
    const annotation = await feedback.createAnnotationInTransaction(client,
      principal, imported.sourceRunId, commandKey, {
        artifactHash: input.artifactHash, labelSet: input.labelSet,
        ...(input.supersedesAnnotationId ? { supersedesAnnotationId: input.supersedesAnnotationId } : {}),
        provenance: { method: "full_diff_review", ...(input.notes ? { notes: input.notes } : {}) },
      });
    const reviewed = await inbox.reviewInTransaction(client, reviewScope, {
      annotationId, expectedContentHash: input.expectedContentHash, decision: "promoted",
      reviewer, commandKey,
    });
    return { imported: reviewed, trustedAnnotation: annotation };
  });
}

function scope(principal: RunPrincipal): QualityScope {
  return { tenantId: principal.tenantId, integrationId: principal.integrationId };
}
function actor(principal: RunPrincipal) {
  return { actorType: principal.actorType, actorId: principal.subjectId };
}
function snapshotPrincipal(principal: RunPrincipal): Record<string, unknown> {
  return { subjectId: principal.subjectId, actorType: principal.actorType, tenantId: principal.tenantId,
    integrationId: principal.integrationId, permissions: [...principal.permissions].sort() };
}
export function buildQualitySyncJobInput(principal: RunPrincipal, targetFingerprint: string,
  kind: QualitySyncJobKind, commandKey: string, input: Record<string, unknown>): EnqueueQualitySyncJobInput {
  const principalSnapshot = snapshotPrincipal(principal);
  const payload = { ...input, principal: principalSnapshot };
  return { kind,
    externalId: `quality:${fingerprint({ schemaVersion: 1, kind, targetFingerprint,
      tenantId: principal.tenantId, integrationId: principal.integrationId, commandKey })}`,
    idempotencyKey: commandKey,
    requestHash: fingerprint({ schemaVersion: 1, kind, targetFingerprint, payload }),
    targetFingerprint, payload, principal: principalSnapshot };
}
function annotationReviewCommand(annotationId: string, contentHash: string,
  decision: "promoted" | "rejected"): string {
  return `quality-annotation:${annotationId}:${contentHash}:${decision}`;
}
