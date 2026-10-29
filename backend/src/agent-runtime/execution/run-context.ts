import { AsyncLocalStorage } from "node:async_hooks";

import type { DiffFileContext } from "../../repository/contracts.js";
import type { RunLease, RunStepKind } from "../runs/contracts.js";
import { fingerprint } from "../versions.js";

export interface RunExecutionContext {
  lease: RunLease;
  signal?: AbortSignal;
  assertActive(): Promise<void>;
  step<T>(key: string, kind: RunStepKind, inputHash: string, action: () => Promise<T>): Promise<T>;
}

const contexts = new AsyncLocalStorage<RunExecutionContext>();

export function withRunExecutionContext<T>(context: RunExecutionContext, action: () => Promise<T>): Promise<T> {
  return contexts.run(context, action);
}

export function currentRunExecutionContext(): RunExecutionContext | undefined {
  return contexts.getStore();
}

export function currentRunLease(): RunLease | undefined {
  return contexts.getStore()?.lease;
}

export async function assertRunActive(): Promise<void> {
  await contexts.getStore()?.assertActive();
}

export function assertReviewRunRevision(baseSha: string, headSha: string): void {
  const lease = currentRunLease();
  if (lease && (lease.baseSha !== baseSha || lease.headSha !== headSha)) {
    throw new ReviewRunRevisionChangedError();
  }
}

export class ReviewRunRevisionChangedError extends Error {
  constructor() {
    super("Review revision changed after durable intake");
    this.name = "ReviewRunRevisionChangedError";
  }
}

export class DeepReviewAnalysisFailedError extends Error {
  constructor() { super("Deep review roles failed; inspect the incomplete artifact"); this.name = "DeepReviewAnalysisFailedError"; }
}

export function reviewInputHash(input: unknown): string {
  return fingerprint(input);
}

export async function durableReviewCollection<T extends { files: DiffFileContext[] }>(
  key: string,
  action: () => Promise<T>,
): Promise<T> {
  const context = currentRunExecutionContext();
  if (!context) return action();
  const inputHash = reviewInputHash({
    key, runId: context.lease.runId, baseSha: context.lease.baseSha,
    headSha: context.lease.headSha, toolVersionHash: context.lease.toolVersionHash,
  });
  const saved = await context.step(key, "tool", inputHash, async () => {
    const result = await action();
    return {
      ...result,
      files: result.files.map(({ oldLinesWithNumber, newLinesWithNumber, ...file }) => ({
        ...file, oldLinesWithNumber: [...oldLinesWithNumber], newLinesWithNumber: [...newLinesWithNumber],
      })),
    };
  });
  return {
    ...saved,
    files: saved.files.map((file) => ({
      ...file,
      oldLinesWithNumber: new Map(file.oldLinesWithNumber),
      newLinesWithNumber: new Map(file.newLinesWithNumber),
    })),
  } as T;
}

export async function durableReviewAnalysis<T>(input: unknown, action: () => Promise<T>): Promise<T> {
  const context = currentRunExecutionContext();
  if (!context) return action();
  return context.step("review.analysis", "model", reviewInputHash(input), action);
}
