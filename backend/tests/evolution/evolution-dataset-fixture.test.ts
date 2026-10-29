import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDatasetFixture,
  computeLineageHash,
  computeShingleSignature,
  shingleSimilarity,
  validateDatasetFixture,
  type DatasetRepositoryAdapter,
} from "../../src/evolution/datasets/fixture.js";
import type { DatasetCaseSource } from "../../src/evolution/datasets/contracts.js";

const source: DatasetCaseSource = {
  tenantId: "tenant-a", integrationId: "integration-a", sourceRunId: "00000000-0000-4000-8000-000000000001",
  platform: "github", origin: "https://github.example.test", repository: "Acme/Repo", providerRepositoryId: 7,
  pullNumber: 42, baseSha: "a".repeat(40), headSha: "b".repeat(40), sourceCreatedAt: "2026-01-01T00:00:00.000Z",
  input: { target: { number: 42 } }, collected: { files: [{ newPath: "src/a.ts" }], pull: { title: "review" } },
  collectionStepId: "00000000-0000-4000-8000-000000000002", collectionOutputHash: "c".repeat(64),
  artifactHash: "d".repeat(64), labelSetId: "e".repeat(64), labelSetHash: "f".repeat(64), labelSet: {},
};

test("dataset fixture reads only the fixed revision tree and excludes secret-like files", async () => {
  const reads: string[] = [];
  const fixture = await buildDatasetFixture(source, adapter({
    "src/a.ts": "export const value = 1;\n", "package.json": "{\"name\":\"fixture\"}\n", ".env": "TOKEN=secret\n",
  }, reads));

  assert.deepEqual(reads, ["package.json", "src/a.ts"]);
  assert.deepEqual(fixture.files.map(({ path, kind }) => ({ path, kind })), [
    { path: "package.json", kind: "manifest" }, { path: "src/a.ts", kind: "source" },
  ]);
  assert.equal(fixture.headSha, source.headSha);
});

test("dataset fixture identity is stable across provider tree ordering", async () => {
  const files = { "src/b.ts": "export const b = 2;\n", "src/a.ts": "export const a = 1;\n" };
  const left = await buildDatasetFixture(source, adapter(files, [], Object.keys(files)));
  const right = await buildDatasetFixture(source, adapter(files, [], Object.keys(files).reverse()));

  assert.equal(left.fixtureHash, right.fixtureHash);
});

test("dataset fixture validation binds the redacted input and collection snapshots", async () => {
  const fixture = await buildDatasetFixture(source, adapter({ "src/a.ts": "changed" }, []));
  assert.doesNotThrow(() => validateDatasetFixture(source, fixture));
  assert.throws(() => validateDatasetFixture(source, { ...fixture, collected: { files: [] } }),
    /identity mismatch/);
});

test("dataset fixture captures changed files and approved manifests but not unrelated repository files", async () => {
  const reads: string[] = [];
  const fixture = await buildDatasetFixture(source, adapter({
    "src/a.ts": "changed", "src/unrelated.ts": "not part of the fixture", "package.json": "{}",
  }, reads));

  assert.deepEqual(reads, ["package.json", "src/a.ts"]);
  assert.deepEqual(fixture.files.map(({ path }) => path), ["package.json", "src/a.ts"]);
  assert.deepEqual(fixture.coverage.repositoryRead, { status: "partial",
    reasonCodes: ["repository_read_scoped_to_changed_and_manifests"],
    availablePaths: ["package.json", "src/a.ts"] });
});

test("dataset fixture fails closed when a declared changed file is unavailable or sensitive", async () => {
  await assert.rejects(buildDatasetFixture(source, adapter({ "package.json": "{}" }, [])),
    /declared changed file is unavailable/);
  await assert.rejects(buildDatasetFixture({ ...source, collected: { files: [{ newPath: "config.tfvars" }] } },
    adapter({ "config.tfvars": "token = secret" }, [])), /declared changed file is sensitive or unsupported/);
});

test("dataset fixture skips removed paths at the head revision and fails explicitly when no replay files remain", async () => {
  const removed = { ...source, collected: { files: [{ newPath: "src/removed.ts", status: "removed" }] } };
  const fixture = await buildDatasetFixture(removed, adapter({ "package.json": "{}" }, []));
  assert.deepEqual(fixture.files.map(({ path }) => path), ["package.json"]);
  await assert.rejects(buildDatasetFixture(removed, adapter({ "src/current.ts": "current" }, [])),
    /filtered repository fixture is empty or oversized/);
});

test("dataset fixture rejects provider content whose returned path does not match the fixed tree entry", async () => {
  const changed: DatasetRepositoryAdapter = {
    listFiles: async () => ["src/a.ts"], readCiStatus: async () => null,
    readFile: async () => ({ path: "src/other.ts", mode: "100644", bytes: Buffer.from("changed") }),
  };

  await assert.rejects(buildDatasetFixture(source, changed), /fixture changed during collection/);
});

test("dataset fixture redacts nested metadata and file secrets without changing file line count", async () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const privateKey = "-----BEGIN PRIVATE KEY-----\nfirst-secret-line\nsecond-secret-line\n-----END PRIVATE KEY-----";
  const fixture = await buildDatasetFixture({ ...source,
    input: { nested: { token: secret } },
    collected: { files: [{ newPath: "src/config.ts", patch: `@@ -0,0 +1 @@\n+${privateKey}\n` }],
      rows: [{ password: "private-password" }] },
  }, adapter({ "src/config.ts": `const token = '${secret}';\n${privateKey}\nexport const ok = true;\n` }, [], undefined,
    { details: { api_key: secret } }));

  const serialized = JSON.stringify(fixture);
  assert.doesNotMatch(serialized, /abcdefghijklmnopqrstuvwxyz123456|private-password|first-secret-line|second-secret-line/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.equal(fixture.files[0]!.content.split("\n").length,
    `const token = '${secret}';\n${privateKey}\nexport const ok = true;\n`.split("\n").length);
  const redactedPatch = (fixture.collected.files as Array<{ patch: string }>)[0]!.patch;
  assert.equal(redactedPatch.split("\n").length, `@@ -0,0 +1 @@\n+${privateKey}\n`.split("\n").length);
});

test("lineage identity normalizes repository case without merging different pull requests", () => {
  assert.equal(computeLineageHash("Acme/Repo", 42), computeLineageHash("acme/repo", 42));
  assert.notEqual(computeLineageHash("acme/repo", 42), computeLineageHash("acme/repo", 43));
});

test("near-duplicate similarity detects identical content independently of file ordering", () => {
  const first = { path: "src/a.ts", kind: "source" as const,
    content: "one two three four five six seven", contentHash: "a".repeat(64), sizeBytes: 33 };
  const second = { ...first, path: "src/b.ts" };
  const left = computeShingleSignature([first, second]);
  const right = computeShingleSignature([second, first]);

  assert.equal(shingleSimilarity(left, right), 1);
});

function adapter(files: Record<string, string>, reads: string[], order = Object.keys(files),
  ci: unknown = { state: "success", sha: source.headSha }): DatasetRepositoryAdapter {
  return {
    listFiles: async () => order,
    readFile: async (path) => { reads.push(path); const content = files[path];
      return content === undefined ? null : { path, mode: "100644", bytes: Buffer.from(content) }; },
    readCiStatus: async () => ci,
  };
}


test("fixture redacts canonical provider and credential URL secret families before storage", async () => {
  const secrets = ["AKIA" + "A".repeat(16), "github_pat_" + "a".repeat(42),
    "postgresql://fixture_user:fixture_password@db.internal:5432/app",
    "AIza" + "b".repeat(35), "npm_" + "c".repeat(36), "xoxb-1234567890-abcdef"];
  const content = secrets.join("\n");
  const fixture = await buildDatasetFixture({ ...source, collected: { input: {}, files: [
    { newPath: "src/a.ts", oldPath: "src/a.ts", status: "modified", patch: content }] } },
    adapter({ "src/a.ts": content }, []));
  const serialized = JSON.stringify(fixture);
  for (const secret of secrets) assert.ok(!serialized.includes(secret));
  assert.equal(fixture.files[0]!.content.split("\n").length, secrets.length);
});
