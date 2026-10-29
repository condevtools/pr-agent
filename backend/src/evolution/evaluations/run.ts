import { randomUUID } from "node:crypto";

import type { PublicationBinding } from "../../agent-runtime/authority/publication-authority.js";
import { executeDeepReviewWithContext } from "../../review/deep/run.js";
import { currentRunExecutionContext } from "../../agent-runtime/execution/run-context.js";
import { DeepReviewAnalysisFailedError } from "../../agent-runtime/execution/run-context.js";
import type { RunLease } from "../../agent-runtime/runs/contracts.js";
import { getAgentRuntimeServices } from "../../agent-runtime/runtime.js";
import type { DiffFileContext } from "../../repository/contracts.js";
import type { PullRequestReviewInput } from "../../review/contracts.js";
import { ReplayFixtureAdapter } from "./fixture-adapter.js";
import { replayRunInputSchema } from "./contracts.js";
import { buildReplayRunCreationInput, ReplayAdmissionManifestDriftError } from "./intake.js";
import { PgEvolutionEvaluationStore } from "./store.js";

export async function executeReplayRun(lease: RunLease, binding: PublicationBinding): Promise<void> {
  const input = replayRunInputSchema.parse(lease.input);
  const context = currentRunExecutionContext();
  if (!context || context.lease.runId !== lease.runId || binding.tenantId !== lease.tenantId
      || binding.id !== lease.integrationId) throw new Error("Replay Run context or binding mismatch");
  const fixture = await new PgEvolutionEvaluationStore((await getAgentRuntimeServices()).db).loadReplayFixture(lease, input);
  const artifact = await executeDeepReviewWithContext(parseCollectedFixture(fixture.collected), new ReplayFixtureAdapter(fixture), context);
  if (artifact.analysisStatus === "failed") throw new DeepReviewAnalysisFailedError();
}

export class EvaluationCoordinator {
  private readonly owner = `evaluation-coordinator-${randomUUID()}`;
  constructor(private readonly store: PgEvolutionEvaluationStore) {}

  async tick(binding: PublicationBinding): Promise<boolean> {
    const lease = await this.store.claim(binding.tenantId, binding.id, this.owner);
    if (!lease) return false;
    await this.store.observeChildren(lease, binding.id);
    for (let slot = 0; slot < 16; slot += 1) {
      const pending = await this.store.nextPending(lease, binding.id);
      if (!pending) break;
      try {
        const attached = await this.store.attachChild(lease, pending, await buildReplayRunCreationInput(binding, pending));
        if (!attached) break;
      } catch (error) {
        if (!(error instanceof ReplayAdmissionManifestDriftError)) throw error;
        await this.store.failAdmissionManifest(lease, pending.id);
        break;
      }
    }
    await this.store.releaseAndFinalize(lease);
    return true;
  }
}

function parseCollectedFixture(value: Record<string, unknown>): {
  input: PullRequestReviewInput; files: DiffFileContext[]; coverage?: { status: "complete" | "partial"; reasonCodes: string[] };
} {
  if (!value.input || typeof value.input !== "object" || !Array.isArray(value.files)) {
    throw new Error("Replay fixture does not contain a production deep-review collection");
  }
  const files = value.files.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("Replay fixture contains an invalid diff file");
    const file = raw as Record<string, unknown>;
    if (typeof file.newPath !== "string" || typeof file.oldPath !== "string" || typeof file.status !== "string"
        || typeof file.patch !== "string" || typeof file.additions !== "number" || typeof file.deletions !== "number"
        || typeof file.extendedDiff !== "string") throw new Error("Replay diff file is incomplete");
    return { newPath: file.newPath, oldPath: file.oldPath, status: file.status, patch: file.patch,
      additions: file.additions, deletions: file.deletions, extendedDiff: file.extendedDiff,
      oldLinesWithNumber: new Map(assertLineEntries(file.oldLinesWithNumber)),
      newLinesWithNumber: new Map(assertLineEntries(file.newLinesWithNumber)) };
  });
  const coverage = value.coverage;
  return { input: value.input as PullRequestReviewInput, files,
    ...(coverage && typeof coverage === "object" && (coverage as { status?: unknown }).status
      ? { coverage: coverage as { status: "complete" | "partial"; reasonCodes: string[] } } : {}) };
}

function assertLineEntries(value: unknown): Array<[number, string]> {
  if (!Array.isArray(value) || value.some((entry) => !Array.isArray(entry) || entry.length !== 2
      || !Number.isSafeInteger(entry[0]) || typeof entry[1] !== "string")) {
    throw new Error("Replay diff line map is invalid");
  }
  return value as Array<[number, string]>;
}
