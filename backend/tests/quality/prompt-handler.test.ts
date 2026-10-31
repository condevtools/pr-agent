import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LangfuseQualityError } from "../../src/quality/langfuse/client.js";
import type { LangfuseQualityPort, TextPromptRecord } from "../../src/quality/langfuse/contracts.js";
import { MANAGED_PROMPT_CATALOG } from "../../src/quality/prompts/catalog.js";
import { promptTemplateHash } from "../../src/quality/prompts/contracts.js";
import { createPromptPullHandler, QualityPromptSyncError,
  type PromptCandidateStorePort } from "../../src/quality/sync/prompt-handler.js";
import type { QualityPromptVersion, QualitySyncJob } from "../../src/quality/storage/contracts.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const INTEGRATION = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const HASH = "a".repeat(64);
const principal = { subjectId: "quality-admin", actorType: "service" as const, tenantId: TENANT,
  integrationId: INTEGRATION, permissions: ["evaluations:read"] };

describe("prompt pull handler", () => {
  it("imports a remote version as a candidate with exact template identity", async () => {
    const client = new PromptClient();
    client.remote = { name: "tenant/review", version: 7, text: "Improve {{input}}", labels: ["candidate"],
      config: { temperature: 0 } };
    const store = new PromptStore();
    const handler = createPromptPullHandler({ client, promptStore: store, targetFingerprint: HASH });

    const result = await handler(job({ promptKey: "evolution.proposal.instruction", remoteName: "tenant/review",
      version: 7, principal }));

    assert.equal(result.status, "candidate");
    assert.equal(client.created.length, 0);
    assert.equal(store.imported.length, 1);
    assert.equal(store.imported[0]?.contentHash, promptTemplateHash("Improve {{input}}"));
    assert.deepEqual(store.imported[0]?.variables, ["input"]);
    assert.equal(store.imported[0]?.actor.actorId, principal.subjectId);
  });

  it("seeds version one only after an explicit not-found and never activates it", async () => {
    const client = new PromptClient();
    client.notFound = true;
    const store = new PromptStore();
    const handler = createPromptPullHandler({ client, promptStore: store, targetFingerprint: HASH });

    const result = await handler(job({ promptKey: "issues.triage.system", remoteName: "tenant/issues.triage.system",
      version: 1, seed: true, principal }));

    assert.equal(result.seeded, true);
    assert.equal(client.created.length, 1);
    assert.equal(client.created[0]?.text, MANAGED_PROMPT_CATALOG["issues.triage.system"].template);
    assert.equal(result.status, "candidate");
  });

  it("does not overwrite an existing version one when seed is requested", async () => {
    const client = new PromptClient();
    client.remote = { name: "tenant/prompt", version: 1, text: "Existing prompt", labels: [] };
    const store = new PromptStore();
    const handler = createPromptPullHandler({ client, promptStore: store, targetFingerprint: HASH });

    const result = await handler(job({ promptKey: "fix.proposal.system", remoteName: "tenant/prompt",
      version: 1, seed: true, principal }));

    assert.equal(result.seeded, false);
    assert.equal(client.created.length, 0);
    assert.equal(store.imported[0]?.template, "Existing prompt");
  });

  it("rejects a remote prompt whose variables drift from the managed catalog ABI", async () => {
    const client = new PromptClient();
    client.remote = { name: "tenant/prompt", version: 4, text: "Review {{unexpected}}", labels: [] };
    const handler = createPromptPullHandler({ client, promptStore: new PromptStore(), targetFingerprint: HASH });

    await assert.rejects(
      handler(job({ promptKey: "review.single.system.en", remoteName: "tenant/prompt", version: 4, principal })),
      (error) => error instanceof QualityPromptSyncError
        && error.code === "QUALITY_PROMPT_VARIABLE_ABI_MISMATCH",
    );
  });

  it("keeps source identity stable when mutable remote labels move", async () => {
    const client = new PromptClient();
    client.remote = { name: "tenant/prompt", version: 4, text: "Stable prompt", labels: ["candidate"] };
    const store = new PromptStore();
    const handler = createPromptPullHandler({ client, promptStore: store, targetFingerprint: HASH });
    const payload = { promptKey: "review.single.system.en", remoteName: "tenant/prompt", version: 4, principal };

    await handler(job(payload));
    client.remote = { ...client.remote, labels: ["production"] };
    await handler(job(payload));

    assert.equal(store.imported[0]?.sourceFingerprint, store.imported[1]?.sourceFingerprint);
  });

  it("fails closed when a seed race creates a different remote version", async () => {
    const client = new PromptClient();
    client.notFound = true;
    client.createdVersion = 2;
    const store = new PromptStore();
    const handler = createPromptPullHandler({ client, promptStore: store, targetFingerprint: HASH });

    await assert.rejects(
      handler(job({ promptKey: "issues.triage.system", remoteName: "tenant/prompt", version: 1,
        seed: true, principal })),
      (error) => error instanceof QualityPromptSyncError
        && error.code === "QUALITY_REMOTE_PROMPT_IDENTITY_MISMATCH",
    );
    assert.equal(store.imported.length, 0);
  });
});

class PromptClient implements LangfuseQualityPort {
  remote: TextPromptRecord = { name: "tenant/prompt", version: 1, text: "Prompt", labels: [] };
  notFound = false;
  createdVersion = 1;
  created: Array<{ name: string; text: string }> = [];

  async getTextPrompt(): Promise<TextPromptRecord> {
    if (this.notFound) throw new LangfuseQualityError("LANGFUSE_QUALITY_NOT_FOUND", "getTextPrompt");
    return this.remote;
  }
  async createTextPrompt(input: { name: string; text: string }): Promise<TextPromptRecord> {
    this.created.push(input);
    return { name: input.name, version: this.createdVersion, text: input.text,
      labels: [], config: { seeded: true } };
  }
  async getOrCreateDataset(): Promise<never> { throw new Error("unused"); }
  async upsertDatasetItem(): Promise<never> { throw new Error("unused"); }
  async linkDatasetRunItem(): Promise<never> { throw new Error("unused"); }
  async getOrCreateScoreConfig(): Promise<never> { throw new Error("unused"); }
  async upsertScore(): Promise<never> { throw new Error("unused"); }
  async getOrCreateAnnotationQueue(): Promise<never> { throw new Error("unused"); }
  async addAnnotationQueueItem(): Promise<never> { throw new Error("unused"); }
  async listHumanAnnotationScores(): Promise<never> { throw new Error("unused"); }
  async listHumanAnnotationScorePage(): Promise<never> { throw new Error("unused"); }
}

class PromptStore implements PromptCandidateStorePort {
  imported: Array<Parameters<PromptCandidateStorePort["importCandidate"]>[1]> = [];
  async importCandidate(_scope: unknown, input: Parameters<PromptCandidateStorePort["importCandidate"]>[1]): Promise<QualityPromptVersion> {
    this.imported.push(input);
    return { id: JOB, scope: { tenantId: TENANT, integrationId: INTEGRATION }, promptKey: input.promptKey,
      remotePromptName: input.remotePromptName, remotePromptVersion: input.remotePromptVersion,
      template: input.template, contentHash: input.contentHash, variables: input.variables,
      sourceFingerprint: input.sourceFingerprint, targetFingerprint: input.targetFingerprint, status: "candidate",
      importedBy: input.actor, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), version: 1 };
  }
}

function job(payload: Record<string, unknown>): QualitySyncJob {
  return { id: JOB, scope: { tenantId: TENANT, integrationId: INTEGRATION }, kind: "prompt_pull",
    externalId: "prompt:1", idempotencyKey: "prompt:1", requestHash: HASH, targetFingerprint: HASH,
    payload, principal: principal as unknown as Record<string, unknown>, status: "running", attemptCount: 1,
    maxAttempts: 3, maxAgeSeconds: 3600, availableAt: new Date(0).toISOString(), leaseOwner: "worker",
    leaseEpoch: 1, leaseExpiresAt: new Date(1).toISOString(), createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(), version: 1 };
}
