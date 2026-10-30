import assert from "node:assert/strict";
import test from "node:test";

import { prepareRunArtifact, RUN_ARTIFACT_LIMITS, RunArtifactLimitError } from "../../src/agent-runtime/artifacts/index.js";
import { boundDurableReviewCollection } from "../../src/agent-runtime/execution/run-context.js";

test("artifact preparation accepts the exact raw limit and rejects one byte over", async () => {
  const exact = await prepareRunArtifact(Buffer.alloc(RUN_ARTIFACT_LIMITS.maxRawBytes),
    { contentType: "application/octet-stream", purpose: "step_output" });
  assert.equal(exact.rawSizeBytes, RUN_ARTIFACT_LIMITS.maxRawBytes);
  await assert.rejects(prepareRunArtifact(Buffer.alloc(RUN_ARTIFACT_LIMITS.maxRawBytes + 1),
    { contentType: "application/octet-stream", purpose: "step_output" }),
  (error: unknown) => error instanceof RunArtifactLimitError && error.code === "artifact_raw_limit");
});

test("artifact preparation rejects incompressible content beyond the compressed limit", async () => {
  const bytes = Buffer.allocUnsafe(RUN_ARTIFACT_LIMITS.maxCompressedBytes + 64 * 1024);
  let state = 0x12345678;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5; bytes[index] = state & 0xff;
  }
  await assert.rejects(prepareRunArtifact(bytes, { contentType: "application/octet-stream", purpose: "other" }),
    (error: unknown) => error instanceof RunArtifactLimitError && error.code === "artifact_compressed_limit");
});

test("collection bounding deterministically records every omitted file and aligns review input", () => {
  const files = ["src/a.ts", "src/b.ts", "src/c.ts"].map((newPath, index) => ({
    newPath, oldPath: newPath, status: "modified", additions: 1, deletions: 0,
    patch: `@@ -0,0 +1 @@\n+${"x".repeat(120 + index)}`,
    extendedDiff: "", oldLinesWithNumber: [], newLinesWithNumber: [[1, "x"]] as Array<[number, string]>,
  }));
  const value = { files, input: { changedFiles: files.map(({ newPath }) => ({ newPath })) },
    coverage: { status: "complete", reasonCodes: [] as string[] }, filesTruncated: false };
  const maxRawBytes = Buffer.byteLength(JSON.stringify({ value: { ...value, files: files.slice(0, 1),
    input: { changedFiles: [{ newPath: "src/a.ts" }] }, coverage: { status: "partial",
      reasonCodes: ["artifact_output_limit"], truncation: { schemaVersion: 1,
        rule: "drop_trailing_files_v1", originalFileCount: 3, retainedFileCount: 1,
        omittedRange: "entire_file", omittedPaths: ["src/b.ts", "src/c.ts"] } }, filesTruncated: true } }));
  const bounded = boundDurableReviewCollection(value, maxRawBytes);
  assert.deepEqual(bounded.files.map((file) => file.newPath), ["src/a.ts"]);
  assert.deepEqual(bounded.input.changedFiles.map((file) => file.newPath), ["src/a.ts"]);
  assert.deepEqual(bounded.coverage, { status: "partial", reasonCodes: ["artifact_output_limit"],
    truncation: { schemaVersion: 1, rule: "drop_trailing_files_v1", originalFileCount: 3,
      retainedFileCount: 1, omittedRange: "entire_file", omittedPaths: ["src/b.ts", "src/c.ts"] } });
  assert.equal(bounded.filesTruncated, true);
  assert.deepEqual(boundDurableReviewCollection(value, maxRawBytes), bounded);
});

test("collection bounding rejects oversized non-file metadata instead of silently cutting it", () => {
  const value = { files: [], input: { changedFiles: [], body: "x".repeat(1_000) },
    coverage: { status: "complete", reasonCodes: [] as string[] } };
  assert.throws(() => boundDurableReviewCollection(value, 100),
    (error: unknown) => error instanceof RunArtifactLimitError && error.code === "artifact_raw_limit");
});

test("collection bounding handles a large file inventory with complete omission metadata", () => {
  const files = Array.from({ length: 2_000 }, (_, index) => ({
    newPath: `src/generated/${String(index).padStart(4, "0")}.ts`, oldPath: "", status: "added",
    additions: 1, deletions: 0, patch: `+${"x".repeat(256)}`, extendedDiff: "",
    oldLinesWithNumber: [] as Array<[number, string]>, newLinesWithNumber: [[1, "x"]] as Array<[number, string]>,
  }));
  const bounded = boundDurableReviewCollection({ files,
    input: { changedFiles: files.map(({ newPath }) => ({ newPath })) },
    coverage: { status: "complete", reasonCodes: [] as string[] } }, 100_000);
  const truncation = bounded.coverage.truncation as { retainedFileCount: number; omittedPaths: string[] };
  assert.ok(truncation.retainedFileCount > 0 && truncation.retainedFileCount < files.length);
  assert.equal(truncation.omittedPaths.length, files.length - truncation.retainedFileCount);
  assert.equal(Buffer.byteLength(JSON.stringify({ value: bounded })) <= 100_000, true);
});
