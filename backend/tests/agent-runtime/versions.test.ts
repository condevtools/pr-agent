import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { buildCodeManifest, fingerprint, runtimeVersionManifest } from "../../src/agent-runtime/versions.js";

test("checkpoint fingerprints survive PostgreSQL JSONB object key ordering", () => {
  assert.equal(fingerprint({ b: [{ x: 1, a: 2 }], a: true }),
    fingerprint({ a: true, b: [{ a: 2, x: 1 }] }));
  assert.notEqual(fingerprint([1, 2]), fingerprint([2, 1]));
});

test("the build manifest separates full-source audit from executable component pins", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-version-"));
  try {
    await mkdir(join(root, "backend/src"), { recursive: true });
    await mkdir(join(root, "backend/scripts"));
    for (const file of ["backend/package.json", "backend/tsconfig.json", "backend/scripts/build.mjs", "backend/scripts/copy-agent-runtime-assets.mjs", "backend/scripts/fix-sandbox-runner.mjs",
      "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "backend/src/main.ts", "backend/src/001.sql"]) {
      await writeFile(join(root, file), "original");
    }
    await writeFile(join(root, "pnpm-lock.yaml"), lockFixture("3.25.76"));
    await mkdir(join(root, "backend/src/review/standard"), { recursive: true });
    await mkdir(join(root, "backend/src/core/http"), { recursive: true });
    await mkdir(join(root, "backend/src/integrations/github/publication"), { recursive: true });
    await mkdir(join(root, "backend/src/fix/verification"), { recursive: true });
    await writeFile(join(root, "backend/src/core/http/retry-options.ts"), "export const retry = 1;");
    await writeFile(join(root, "backend/src/review/standard/reviewer.ts"),
      'import { z } from "zod"; import { retry } from "../../core/http/retry-options.js"; export const prompt = z.string().parse(retry);');
    await writeFile(join(root, "backend/src/integrations/github/publication/adapter.ts"),
      'import { retry } from "../../../core/http/retry-options.js"; export const adapter = retry;');
    const verifierFile = join(root, "backend/src/fix/verification/worker.ts");
    await writeFile(verifierFile, 'export async function load() { return import /* host builtin */ ("node:sqlite"); }');
    const source = pathToFileURL(join(root, "backend/src/"));
    const baseline = await buildCodeManifest(source);
    await writeFile(join(root, "backend/src/main.ts"), "unrelated application bootstrap");
    const unrelated = await buildCodeManifest(source);
    assert.notEqual(unrelated.sourceHash, baseline.sourceHash);
    assert.deepEqual(unrelated.componentHashes, baseline.componentHashes,
      "non-runtime source is audited without stranding queued Runs");
    await writeFile(verifierFile, 'export async function load() { return import /* host builtin */ ("node:sqlite"); } export const revision = 2;');
    const verifierChanged = await buildCodeManifest(source);
    assert.notEqual(verifierChanged.componentHashes.verifier, baseline.componentHashes.verifier);
    assert.equal(verifierChanged.componentHashes.tool, baseline.componentHashes.tool,
      "dedicated verifier host code has an independent compatibility boundary");
    await writeFile(join(root, "backend/src/core/http/retry-options.ts"), "export const retry = 2;");
    const helperChanged = await buildCodeManifest(source);
    assert.notEqual(helperChanged.componentHashes.prompt, baseline.componentHashes.prompt);
    assert.notEqual(helperChanged.componentHashes.tool, baseline.componentHashes.tool,
      "publication adapters include their transitive core HTTP helpers");
    assert.equal(helperChanged.componentHashes.model, baseline.componentHashes.model);
    await writeFile(join(root, "pnpm-lock.yaml"), `${lockFixture("3.25.76")}\n# unrelated frontend lock churn\n`);
    const unrelatedLock = await buildCodeManifest(source);
    assert.notEqual(unrelatedLock.sourceHash, helperChanged.sourceHash);
    assert.deepEqual(unrelatedLock.componentHashes, helperChanged.componentHashes);
    await writeFile(join(root, "pnpm-lock.yaml"), lockFixture("3.26.0"));
    const changedDependencies = await buildCodeManifest(source);
    assert.notEqual(changedDependencies.productionDependencyHashes.prompt,
      unrelatedLock.productionDependencyHashes.prompt);
    assert.notEqual(changedDependencies.componentHashes.prompt, unrelatedLock.componentHashes.prompt);
    assert.equal(changedDependencies.componentHashes.tool, unrelatedLock.componentHashes.tool,
      "a package only imported by prompt code does not invalidate tool compatibility");
    await writeFile(join(root, "backend/package.json"), "changed scripts and devDependencies only");
    const packageMetadataChanged = await buildCodeManifest(source);
    assert.deepEqual(packageMetadataChanged.componentHashes, changedDependencies.componentHashes);
    await writeFile(join(root, "backend/src/001.sql"), "new-schema-contract");
    const changedMigration = await buildCodeManifest(source);
    assert.notEqual(changedMigration.sourceHash, packageMetadataChanged.sourceHash);
    assert.deepEqual(changedMigration.componentHashes, packageMetadataChanged.componentHashes);
    await writeFile(join(root, "backend/scripts/fix-sandbox-runner.mjs"), "changed-sandbox-protocol");
    const changedSandbox = await buildCodeManifest(source);
    assert.notEqual(changedSandbox.sourceHash, changedMigration.sourceHash);
    await writeFile(join(root, "backend/scripts/build.mjs"), "changed-build-pipeline");
    assert.notEqual((await buildCodeManifest(source)).sourceHash, changedSandbox.sourceHash);

    await writeFile(verifierFile, 'import "#unknown/runtime"; export const revision = 3;');
    await assert.rejects(buildCodeManifest(source), /Unknown source alias/);
    await writeFile(verifierFile, 'import "\.\/missing.js"; export const revision = 4;');
    await assert.rejects(buildCodeManifest(source), /Unresolved local import/);
    await writeFile(verifierFile, "const target = 'node:sqlite'; export const load = () => import /* hidden by comment */ (target);");
    await assert.rejects(buildCodeManifest(source), /Non-literal import/);
    await writeFile(verifierFile, "declare const require: (name: string) => unknown; const target = 'node:sqlite'; require(target);");
    await assert.rejects(buildCodeManifest(source), /Non-literal require/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function lockFixture(zodVersion: string): string {
  return `lockfileVersion: '9.0'
importers:
  backend:
    dependencies:
      zod:
        specifier: ^3
        version: ${zodVersion}
packages:
  zod@${zodVersion}:
    resolution: {integrity: sha512-${zodVersion}}
snapshots:
  zod@${zodVersion}: {}
`;
}

test("runtime compatibility pins executable semantics but excludes credentials, billing period, and rates", async () => {
  const names = ["PR_AGENT_LOCALE", "REVIEW_CODE_EXTENSIONS", "OPENAI_API_KEY", "OPENAI_BASE_URL"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.PR_AGENT_LOCALE = "en";
    process.env.REVIEW_CODE_EXTENSIONS = ".ts";
    process.env.OPENAI_BASE_URL = "https://model-one.example/v1";
    process.env.OPENAI_API_KEY = "fixture-one";
    const policy = { version: "test", provider: "openai", model: "gpt-test", periodKey: "2026-10",
      rates: { inputMicrosPerMillion: 1 }, maxOutputTokens: 1000, maxPhysicalCallsPerStep: 2,
      tenantLimits: { costMicros: 10 }, runLimits: { costMicros: 5 } };
    const baseline = await runtimeVersionManifest(policy);
    const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
    const node = Object.getOwnPropertyDescriptor(process.versions, "node")!;
    try {
      Object.defineProperty(process, "arch", { ...arch, value: arch.value === "x64" ? "arm64" : "x64" });
      const runtimeLine = String(node.value).split(".").slice(0, 2).join(".");
      Object.defineProperty(process.versions, "node", { ...node, value: `${runtimeLine}.999` });
      assert.equal((await runtimeVersionManifest(policy)).runtimeVersionHash, baseline.runtimeVersionHash,
        "architecture and Node patch are deployment audit facts, not execution incompatibilities");
      Object.defineProperty(process.versions, "node", { ...node, value: "99.0.0" });
      assert.notEqual((await runtimeVersionManifest(policy)).runtimeVersionHash, baseline.runtimeVersionHash,
        "a different Node runtime capability line requires a compatible Worker");
    } finally {
      Object.defineProperty(process, "arch", arch);
      Object.defineProperty(process.versions, "node", node);
    }
    process.env.OPENAI_API_KEY = "fixture-two";
    assert.deepEqual(await runtimeVersionManifest(policy), baseline);
    assert.equal((await runtimeVersionManifest({ ...policy, version: "new-pricing-revision", periodKey: "2026-11",
      rates: { inputMicrosPerMillion: 999 }, tenantLimits: { costMicros: 20 },
      runLimits: { costMicros: 6 } })).runtimeVersionHash, baseline.runtimeVersionHash);
    process.env.PR_AGENT_LOCALE = "zh";
    assert.notEqual((await runtimeVersionManifest(policy)).runtimeVersionHash, baseline.runtimeVersionHash);
    process.env.PR_AGENT_LOCALE = "en";
    process.env.REVIEW_CODE_EXTENSIONS = ".py";
    assert.notEqual((await runtimeVersionManifest(policy)).runtimeVersionHash, baseline.runtimeVersionHash);
    process.env.REVIEW_CODE_EXTENSIONS = ".ts";
    process.env.OPENAI_BASE_URL = "https://model-two.example/v1";
    assert.notEqual((await runtimeVersionManifest(policy)).runtimeVersionHash, baseline.runtimeVersionHash);
    process.env.OPENAI_BASE_URL = "https://model-one.example/v1";
    assert.notEqual((await runtimeVersionManifest({ ...policy, model: "gpt-other" })).runtimeVersionHash,
      baseline.runtimeVersionHash);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
