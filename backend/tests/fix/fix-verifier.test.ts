import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import test from "node:test";

import { applyUnifiedPatch } from "../../src/repository/diff/unified-patch.js";
import { prepareSnapshotBundle, readSnapshotBundleContent,
  withMaterializedSnapshot } from "../../src/fix/persistence/snapshot-bundle.js";
import { evaluateVerificationResult, sandboxCommandResultSchema, type SandboxRunnerResult } from "../../src/fix/verification/sandbox-result.js";
import { isFixDifferentialEligible } from "../../src/fix/verification/gate.js";

test("strict unified patch applies exact context and rejects traversal/mismatch", () => {
  const files = new Map([["src/math.js", "export const add = (a, b) => a + b;\n"]]);
  const patch = ["diff --git a/src/math.js b/src/math.js", "--- a/src/math.js", "+++ b/src/math.js",
    "@@ -1 +1 @@", "-export const add = (a, b) => a + b;", "+export const add = (a, b) => Number(a) + Number(b);", ""].join("\n");
  assert.equal(applyUnifiedPatch(files, patch).get("src/math.js"), "export const add = (a, b) => Number(a) + Number(b);\n");
  assert.throws(() => applyUnifiedPatch(files, patch.replace("a + b", "a - b")), /context/);
  assert.throws(() => applyUnifiedPatch(files, patch.replaceAll("src/math.js", "../secret")), /path/);
});

test("snapshot preparation rejects invalid UTF-8 and artifact overflow without partial coverage", async () => {
  await assert.rejects(prepareSnapshotBundle({ headSha: "a".repeat(40), dependencyLockHash: "b".repeat(64),
    files: [{ path: "src/invalid.ts", content: Buffer.from([0xff]) }] }), /UTF-8/);
  await assert.rejects(prepareSnapshotBundle({ headSha: "a".repeat(40), dependencyLockHash: "b".repeat(64),
    files: [{ path: "src/large.ts", content: Buffer.from("\\".repeat(17 * 1024 * 1024)) }] }),
  (error: unknown) => error instanceof Error && error.message === "artifact_raw_limit");
});

test("snapshot preparation preserves a valid UTF-8 byte-order mark", async () => {
  const content = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a]);
  const snapshot = await prepareSnapshotBundle({ headSha: "a".repeat(40), dependencyLockHash: "b".repeat(64),
    files: [{ path: "src/bom.ts", content }] });
  const read = readSnapshotBundleContent({ content: snapshot.content, sourceBundleRef: snapshot.sourceBundleRef,
    sourceBundleHash: snapshot.sourceBundleHash });
  assert.equal(Buffer.from(read.files.get("src/bom.ts")!, "utf8").equals(content), true);
});

test("snapshot materialization uses a fresh internal path and cleans it after failure", async () => {
  const snapshot = await prepareSnapshotBundle({ headSha: "a".repeat(40), dependencyLockHash: "b".repeat(64),
    files: [{ path: "src/a.ts", content: Buffer.from("export const a = 1;\n") }] });
  let directory = "";
  await assert.rejects(withMaterializedSnapshot({ content: snapshot.content,
    sourceBundleRef: snapshot.sourceBundleRef, sourceBundleHash: snapshot.sourceBundleHash }, async (path) => {
    directory = path;
    assert.equal((await stat(`${path}/files/src/a.ts`)).isFile(), true);
    throw new Error("fixture failure");
  }), /fixture failure/);
  await assert.rejects(stat(directory), { code: "ENOENT" });
});

test("snapshot reader validates content address and returns exact source files", async () => {
  const lock = Buffer.from("{}\n");
  const written = await prepareSnapshotBundle({ headSha: "a".repeat(40),
      dependencyLockHash: sha(lock), files: [
        { path: "package-lock.json", content: lock },
        { path: "src/math.js", content: Buffer.from("export const add=(a,b)=>a+b;\n") },
      ] });
    const read = readSnapshotBundleContent({ content: written.content, sourceBundleRef: written.sourceBundleRef,
      sourceBundleHash: written.sourceBundleHash });
  assert.equal(read.files.get("package-lock.json"), "{}\n");
  assert.equal(read.files.size, 2);
  assert.equal(sha(written.content), written.sourceBundleHash);
  assert.equal(written.sourceBundleRef, `artifact:${written.sourceBundleHash}`);
  assert.throws(() => readSnapshotBundleContent({ content: Buffer.concat([written.content, Buffer.from(" ")]),
    sourceBundleRef: written.sourceBundleRef, sourceBundleHash: written.sourceBundleHash }), /hash/);
});

test("verification cannot pass on missing or failing regression execution", () => {
  const command = (status: "pass" | "fail", testsRun: number, failedTests: string[] = []) =>
    ({ status, exitCode: status === "pass" ? 0 : 1, failedTests, testsRun, log: "", logTruncated: false });
  const evaluate = (runner: SandboxRunnerResult) => evaluateVerificationResult({ runner, relevance: "verified",
    relevanceReasons: [], imageDigest: `sha256:${"a".repeat(64)}`, policyHash: "b".repeat(64),
    proposalHash: "c".repeat(64), logHashes: {} });
  const missing = evaluate({ protocolVersion: 1, baselineTarget: command("fail", 1), patchedTarget: command("pass", 1),
    baselineRegression: command("pass", 0), patchedRegression: command("pass", 0) });
  assert.equal(missing.outcome, "suggestion_only");
  assert.ok(missing.reasonCodes.includes("baseline_regression_executed_no_tests"));
  const nonTapFailure = evaluate({ protocolVersion: 1, baselineTarget: command("fail", 0),
    patchedTarget: command("pass", 1), baselineRegression: command("pass", 1), patchedRegression: command("pass", 1) });
  assert.equal(nonTapFailure.outcome, "suggestion_only");
  assert.ok(nonTapFailure.reasonCodes.includes("baseline_target_executed_no_tests"));
  const bothFail = evaluate({ protocolVersion: 1, baselineTarget: command("fail", 1), patchedTarget: command("pass", 1),
    baselineRegression: command("fail", 1), patchedRegression: command("fail", 1) });
  assert.equal(bothFail.outcome, "suggestion_only");
  assert.ok(bothFail.reasonCodes.includes("baseline_regression_did_not_pass"));
  assert.ok(bothFail.reasonCodes.includes("patched_regression_did_not_pass"));
  assert.throws(() => sandboxCommandResultSchema.parse({ ...command("fail", 1), failedTests: ["secret test name"] }));
});

test("publication eligibility requires complete clean differential evidence", () => {
  const eligible = { outcome: "suggestion_only" as const, reasonCodes: ["relevance_not_verified"],
    baselineTarget: "fail" as const, patchedTarget: "pass" as const,
    baselineRegression: [], patchedRegression: [], relevance: "unknown" as const, logRefs: {},
    logHashes: { baselineTarget: "1".repeat(64), patchedTarget: "2".repeat(64),
      baselineRegression: "3".repeat(64), patchedRegression: "4".repeat(64) },
    imageDigest: `sha256:${"a".repeat(64)}`, policyHash: "b".repeat(64), proposalHash: "c".repeat(64) };
  assert.equal(isFixDifferentialEligible(eligible), true);
  assert.equal(isFixDifferentialEligible({ ...eligible, reasonCodes: ["baseline_regression_did_not_pass"] }), false);
  assert.equal(isFixDifferentialEligible({ ...eligible, baselineRegression: ["d".repeat(64)] }), false);
  assert.equal(isFixDifferentialEligible({ ...eligible,
    logHashes: { ...eligible.logHashes, patchedRegression: undefined } }), false);
});

function sha(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
