import { AsyncLocalStorage } from "node:async_hooks";

import type { DiffFileContext } from "../../repository/contracts.js";
import { RUN_ARTIFACT_LIMITS, RunArtifactLimitError } from "../artifacts/index.js";
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
  const saved = await context.step<SerializableCollection>(key, "tool", inputHash, async () => {
    const result = await action();
    const serializable = {
      ...result,
      files: result.files.map(({ oldLinesWithNumber, newLinesWithNumber, ...file }) => ({
        ...file, oldLinesWithNumber: [...oldLinesWithNumber], newLinesWithNumber: [...newLinesWithNumber],
      })),
    } as unknown as SerializableCollection;
    return boundDurableReviewCollection(serializable);
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

interface SerializableCollectionFile {
  newPath: string;
  oldLinesWithNumber: Array<[number, string]>;
  newLinesWithNumber: Array<[number, string]>;
  [key: string]: unknown;
}

interface SerializableCollection {
  files: SerializableCollectionFile[];
  input?: { changedFiles?: Array<{ newPath?: unknown; [key: string]: unknown }>; [key: string]: unknown };
  coverage?: { status?: unknown; reasonCodes?: unknown; [key: string]: unknown };
  filesTruncated?: boolean;
  [key: string]: unknown;
}

export function boundDurableReviewCollection<T extends SerializableCollection>(
  value: T,
  maxRawBytes = RUN_ARTIFACT_LIMITS.maxRawBytes,
): T {
  if (!Number.isSafeInteger(maxRawBytes) || maxRawBytes < 1) throw new Error("invalid collection artifact limit");
  if (serializedStepOutputBytes(value) <= maxRawBytes) return value;
  const originalFiles = value.files;
  const candidateFor = (retainedCount: number): T => {
    const retainedFiles = originalFiles.slice(0, retainedCount);
    const omittedPaths = originalFiles.slice(retainedCount).map((file) => file.newPath);
    const retainedPaths = new Set(retainedFiles.map((file) => file.newPath));
    const reasonCodes = new Set(Array.isArray(value.coverage?.reasonCodes)
      ? value.coverage.reasonCodes.filter((item): item is string => typeof item === "string") : []);
    reasonCodes.add("artifact_output_limit");
    const candidate = {
      ...value,
      files: retainedFiles,
      ...(value.input ? { input: {
        ...value.input,
        ...(Array.isArray(value.input.changedFiles) ? {
          changedFiles: value.input.changedFiles.filter((file) =>
            typeof file.newPath === "string" && retainedPaths.has(file.newPath)),
        } : {}),
      } } : {}),
      coverage: {
        ...value.coverage,
        status: "partial",
        reasonCodes: [...reasonCodes],
        truncation: {
          schemaVersion: 1,
          rule: "drop_trailing_files_v1",
          originalFileCount: originalFiles.length,
          retainedFileCount: retainedFiles.length,
          omittedRange: "entire_file",
          omittedPaths,
        },
      },
      ...(Object.hasOwn(value, "filesTruncated") ? { filesTruncated: true } : {}),
    } as T;
    return candidate;
  };
  const empty = candidateFor(0);
  if (serializedStepOutputBytes(empty) > maxRawBytes) {
    throw new RunArtifactLimitError("artifact_raw_limit");
  }
  let lower = 0;
  let upper = originalFiles.length - 1;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (serializedStepOutputBytes(candidateFor(middle)) <= maxRawBytes) lower = middle;
    else upper = middle - 1;
  }
  const bounded = candidateFor(lower);
  if (serializedStepOutputBytes(bounded) > maxRawBytes) {
    throw new RunArtifactLimitError("artifact_raw_limit");
  }
  return bounded;
}

function serializedStepOutputBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify({ value }));
  } catch {
    throw new RunArtifactLimitError("artifact_raw_limit");
  }
}

export async function durableReviewAnalysis<T>(input: unknown, action: () => Promise<T>): Promise<T> {
  const context = currentRunExecutionContext();
  if (!context) return action();
  return context.step("review.analysis", "model", reviewInputHash(input), action);
}
