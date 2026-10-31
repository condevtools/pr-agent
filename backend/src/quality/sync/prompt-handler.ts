import type { RunPermission, RunPrincipal } from "../../agent-runtime/runs/control-contracts.js";
import { RUN_PERMISSIONS } from "../../agent-runtime/runs/control-contracts.js";
import { fingerprint } from "../../agent-runtime/versions.js";
import { LangfuseQualityError } from "../langfuse/client.js";
import type { LangfuseQualityPort, TextPromptRecord } from "../langfuse/contracts.js";
import { MANAGED_PROMPT_CATALOG } from "../prompts/catalog.js";
import { MANAGED_PROMPT_KEYS, promptTemplateHash, promptTemplateVariables,
  type ManagedPromptKey } from "../prompts/contracts.js";
import type { QualityPromptVersion, QualitySyncJob } from "../storage/contracts.js";

const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REMOTE_PROMPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;

export interface PromptCandidateStorePort {
  importCandidate(scope: { tenantId: string; integrationId: string }, input: {
    promptKey: string;
    remotePromptName: string;
    remotePromptVersion: number;
    template: unknown;
    contentHash: string;
    variables: string[];
    sourceFingerprint: string;
    targetFingerprint: string;
    actor: { actorType: "user" | "service"; actorId: string };
  }): Promise<QualityPromptVersion>;
}

export class QualityPromptSyncError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "QualityPromptSyncError";
  }
}

export function createPromptPullHandler(input: {
  client: LangfuseQualityPort;
  promptStore: PromptCandidateStorePort;
  targetFingerprint: string;
}): (job: QualitySyncJob, context?: { signal: AbortSignal }) => Promise<Record<string, unknown>> {
  if (!HASH.test(input.targetFingerprint)) throw new QualityPromptSyncError("QUALITY_TARGET_INVALID");
  return async (job, context) => {
    context?.signal.throwIfAborted();
    if (job.kind !== "prompt_pull") throw new QualityPromptSyncError("QUALITY_JOB_KIND_MISMATCH");
    if (job.targetFingerprint !== input.targetFingerprint) {
      throw new QualityPromptSyncError("QUALITY_TARGET_CHANGED");
    }
    const principal = parsePrincipal(job.principal);
    if (principal.tenantId !== job.scope.tenantId || principal.integrationId !== job.scope.integrationId) {
      throw new QualityPromptSyncError("QUALITY_PRINCIPAL_SCOPE_MISMATCH");
    }
    const payload = parsePayload(job.payload);
    assertSamePrincipal(payload.principal, principal);
    const definition = MANAGED_PROMPT_CATALOG[payload.promptKey];
    let remote: TextPromptRecord;
    let seeded = false;
    if (payload.seed) {
      if (payload.version !== 1) throw new QualityPromptSyncError("QUALITY_PROMPT_SEED_VERSION_INVALID");
      try {
        context?.signal.throwIfAborted();
        remote = await input.client.getTextPrompt(payload.remoteName, 1, { signal: context?.signal });
      } catch (error) {
        if (!(error instanceof LangfuseQualityError) || error.code !== "LANGFUSE_QUALITY_NOT_FOUND") throw error;
        context?.signal.throwIfAborted();
        remote = await input.client.createTextPrompt({
          name: payload.remoteName,
          text: definition.template,
          config: { schemaVersion: 1, managedPromptKey: payload.promptKey,
            contentHash: promptTemplateHash(definition.template) },
          commitMessage: `Seed ${payload.promptKey}`,
        }, { signal: context?.signal });
        seeded = true;
      }
    } else {
      context?.signal.throwIfAborted();
      remote = await input.client.getTextPrompt(payload.remoteName, payload.version, { signal: context?.signal });
    }
    if (remote.name !== payload.remoteName || remote.version !== payload.version) {
      throw new QualityPromptSyncError("QUALITY_REMOTE_PROMPT_IDENTITY_MISMATCH");
    }
    if (seeded && remote.text !== definition.template) {
      throw new QualityPromptSyncError("QUALITY_PROMPT_SEED_RESPONSE_MISMATCH");
    }
    const contentHash = promptTemplateHash(remote.text);
    const variables = promptTemplateVariables(remote.text);
    const expectedVariables = promptTemplateVariables(definition.template);
    if (!sameVariables(variables, expectedVariables)) {
      throw new QualityPromptSyncError("QUALITY_PROMPT_VARIABLE_ABI_MISMATCH");
    }
    const sourceFingerprint = fingerprint({ schemaVersion: 1, promptKey: payload.promptKey,
      remoteName: remote.name, remoteVersion: remote.version, type: "text", contentHash,
      variables, config: remote.config ?? null });
    context?.signal.throwIfAborted();
    const imported = await input.promptStore.importCandidate({ tenantId: principal.tenantId,
      integrationId: principal.integrationId }, {
      promptKey: payload.promptKey,
      remotePromptName: remote.name,
      remotePromptVersion: remote.version,
      template: remote.text,
      contentHash,
      variables,
      sourceFingerprint,
      targetFingerprint: input.targetFingerprint,
      actor: { actorType: principal.actorType, actorId: principal.subjectId },
    });
    return { promptVersionId: imported.id, promptKey: payload.promptKey, remoteName: remote.name,
      remoteVersion: remote.version, contentHash, sourceFingerprint, status: imported.status, seeded };
  };
}

function sameVariables(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parsePayload(value: Record<string, unknown>): { promptKey: ManagedPromptKey; remoteName: string;
  version: number; seed: boolean; principal: unknown } {
  if (typeof value.promptKey !== "string" || !MANAGED_PROMPT_KEYS.includes(value.promptKey as ManagedPromptKey)
      || typeof value.remoteName !== "string" || !REMOTE_PROMPT_NAME.test(value.remoteName.trim())
      || !Number.isSafeInteger(value.version) || Number(value.version) < 1
      || (value.seed !== undefined && typeof value.seed !== "boolean")) {
    throw new QualityPromptSyncError("QUALITY_PROMPT_PAYLOAD_INVALID");
  }
  return { promptKey: value.promptKey as ManagedPromptKey, remoteName: value.remoteName.trim(),
    version: Number(value.version), seed: value.seed === true, principal: value.principal };
}

function parsePrincipal(value: Record<string, unknown>): RunPrincipal {
  if (typeof value.subjectId !== "string" || value.subjectId.length < 1 || value.subjectId.length > 512
      || (value.actorType !== "user" && value.actorType !== "service")
      || typeof value.tenantId !== "string" || !UUID.test(value.tenantId)
      || typeof value.integrationId !== "string" || !UUID.test(value.integrationId)
      || !Array.isArray(value.permissions) || value.permissions.some((permission) => typeof permission !== "string"
        || !RUN_PERMISSIONS.includes(permission as RunPermission))) {
    throw new QualityPromptSyncError("QUALITY_PRINCIPAL_INVALID");
  }
  return { subjectId: value.subjectId, actorType: value.actorType, tenantId: value.tenantId,
    integrationId: value.integrationId, permissions: [...new Set(value.permissions as RunPermission[])] };
}

function assertSamePrincipal(value: unknown, expected: RunPrincipal): void {
  if (!value || typeof value !== "object") throw new QualityPromptSyncError("QUALITY_PRINCIPAL_SNAPSHOT_MISMATCH");
  const actual = parsePrincipal(value as Record<string, unknown>);
  const normalized = (principal: RunPrincipal) => ({ ...principal, permissions: [...principal.permissions].sort() });
  if (fingerprint(normalized(actual)) !== fingerprint(normalized(expected))) {
    throw new QualityPromptSyncError("QUALITY_PRINCIPAL_SNAPSHOT_MISMATCH");
  }
}
