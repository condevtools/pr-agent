import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import type { FixProposal } from "../../src/fix/contracts.js";
import { DockerFixVerifier } from "../../src/fix/verification/docker-verifier.js";
import { loadFixPolicyRegistry } from "../../src/fix/proposal/policy.js";
import { expectedSandboxPolicyHash } from "../../src/fix/verification/sandbox-policy.js";
import { writeSnapshotBundle } from "../../src/fix/persistence/snapshot-bundle.js";
import { fingerprint } from "../../src/agent-runtime/versions.js";

const imageDigest = process.env.FIX_VERIFIER_SANDBOX_IMAGE_DIGEST;

test("real Docker verifier proves differential and isolates credentials/socket/root/network", {
  skip: !imageDigest ? "set FIX_VERIFIER_SANDBOX_IMAGE_DIGEST to run the real Docker sandbox" : false,
  timeout: 120_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "fix-docker-"));
  try {
    const lock = "{}\n";
    const source = `export function divide(a, b) {\n  return a / b;\n}\n`;
    const securityTest = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport fs from "node:fs";\n`+
      `test("no credential", () => assert.equal(process.env.GITHUB_TOKEN, undefined));\n`+
      `test("no docker socket", () => assert.equal(fs.existsSync("/var/run/docker.sock"), false));\n`+
      `test("root filesystem read only", () => assert.throws(() => fs.writeFileSync("/root-probe", "x")));\n`+
      `test("network has no default route", () => assert.equal(fs.readFileSync("/proc/net/route", "utf8").trim().split("\\n").length, 1));\n`;
    const bundle = await writeSnapshotBundle({ root, headSha: "a".repeat(40), dependencyLockHash: sha(lock), files: [
      { path: "package-lock.json", content: Buffer.from(lock) },
      { path: "package.json", content: Buffer.from('{"type":"module"}\n') },
      { path: "src/math.js", content: Buffer.from(source) },
      { path: "test/existing.test.js", content: Buffer.from(securityTest) },
    ] });
    const sandboxConfig = { nodeImageDigest: imageDigest!, deadlineMs: 20_000, maxLogBytes: 8_192,
      memoryMb: 128, cpuCount: 1, pidsLimit: 64, tmpfsMb: 64 };
    const rawPolicy = JSON.stringify({ "node-v1": {
      nodeImageDigest: imageDigest, argv: ["node", "--test", "test/existing.test.js"],
      dependencyLockPath: "package-lock.json", dependencyLockHash: sha(lock),
      sandboxHash: expectedSandboxPolicyHash(sandboxConfig),
      allowedTestPrefixes: ["test"], relevanceTokens: ["divide"], ...sandboxConfig,
      publisherPolicyId: "publisher-v1", publisherPolicyHash: "c".repeat(64), publishEnabled: false,
    } });
    const policy = loadFixPolicyRegistry(rawPolicy).get("node-v1")!;
    const codePatch = ["diff --git a/src/math.js b/src/math.js", "--- a/src/math.js", "+++ b/src/math.js",
      "@@ -1,3 +1,4 @@", " export function divide(a, b) {", "+  if (b === 0) throw new Error(\"zero divisor\");",
      "   return a / b;", " }", ""].join("\n");
    const testPatch = ["diff --git a/test/divide-zero.test.js b/test/divide-zero.test.js", "new file mode 100644",
      "--- /dev/null", "+++ b/test/divide-zero.test.js", "@@ -0,0 +1,5 @@", "+import test from \"node:test\";",
      "+import assert from \"node:assert/strict\";", "+import { divide } from \"../src/math.js\";",
      "+test(\"divide rejects zero\", () => assert.throws(() => divide(1, 0), /zero divisor/));", "+", ""].join("\n");
    const identity = { tenantId: "00000000-0000-4000-8000-000000000001",
      integrationId: "00000000-0000-4000-8000-000000000002", runId: "00000000-0000-4000-8000-000000000003",
      sourceReviewRunId: "00000000-0000-4000-8000-000000000004", findingId: "d".repeat(64), revision: 1 as const,
      repository: "owner/repo", baseSha: "e".repeat(40), headSha: "a".repeat(40),
      sourceBundleRef: bundle.sourceBundleRef, sourceBundleHash: bundle.sourceBundleHash,
      codePatch, testPatch, codePatchHash: sha(codePatch), testPatchHash: sha(testPatch), policyId: policy.id,
      policyHash: policy.hash, trustedCommandHash: fingerprint(policy.argv), dependencyLockPath: policy.dependencyLockPath,
      dependencyLockHash: policy.dependencyLockHash, sandboxPolicyHash: policy.sandboxHash,
      imageDigest: policy.nodeImageDigest, publisherPolicyHash: policy.publisherPolicyHash,
      qualificationStatus: "not_verified" as const };
    const proposalHash = fingerprint(identity);
    const proposal: FixProposal = { id: fingerprint({ runId: identity.runId, revision: 1, proposalHash }), ...identity, proposalHash };
    const resource = resourceContext();
    const result = await new DockerFixVerifier({ snapshotRoot: root }).verify(proposal, policy, resource);
    assert.equal(result.outcome, "suggestion_only", JSON.stringify(result));
    assert.equal(result.baselineTarget, "fail");
    assert.equal(result.patchedTarget, "pass");
    assert.deepEqual(result.baselineRegression, []);
    assert.deepEqual(result.patchedRegression, []);
    assert.equal(result.relevance, "unknown");
    assert.equal(result.relevanceAttestation, undefined);
    assert.ok(result.reasonCodes.includes("relevance_attestation_missing"));

    const hangingPatch = addedTestPatch("test/hanging.test.js", [
      'import test from "node:test";', 'import assert from "node:assert/strict";',
      'import { divide } from "../src/math.js";',
      'test("divide hangs", () => { assert.equal(typeof divide, "function"); while (true) {} });',
    ]);
    const hanging = await new DockerFixVerifier({ snapshotRoot: root }).verify(
      proposalVariant(identity, hangingPatch), policy, resource);
    assert.equal(hanging.outcome, "suggestion_only");
    assert.equal(hanging.baselineTarget, "timeout");
    assert.equal(hanging.patchedTarget, "timeout");
    assert.equal(dockerIds(["ps", "-aq", "--filter", `label=pr-agent.fix-verifier-job=${resource.jobId}`]), "");
    assert.equal(dockerIds(["volume", "ls", "-q", "--filter", `label=pr-agent.fix-verifier-job=${resource.jobId}`]), "");

    const noisyPatch = addedTestPatch("test/noisy.test.js", [
      'import test from "node:test";', 'import assert from "node:assert/strict";',
      'import { divide } from "../src/math.js";',
      'test("divide noisy failure", () => { console.log("x".repeat(100000)); assert.fail(String(divide(1, 1))); });',
    ]);
    const noisy = await new DockerFixVerifier({ snapshotRoot: root }).verify(
      proposalVariant(identity, noisyPatch), policy, resource);
    assert.equal(noisy.outcome, "suggestion_only");
    assert.ok(Buffer.byteLength(JSON.stringify(noisy)) < 8_192);
    assert.equal(JSON.stringify(noisy).includes("x".repeat(100)), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("orphan sweeper reaps only expired crash leftovers and preserves active resources", {
  skip: !imageDigest ? "set FIX_VERIFIER_SANDBOX_IMAGE_DIGEST to run the real Docker sandbox" : false,
  timeout: 60_000,
}, async () => {
  const verifier = new DockerFixVerifier({ snapshotRoot: tmpdir() });
  const expired = await createCrashedResources(imageDigest!, Date.now() - 120_000);
  const active = await createCrashedResources(imageDigest!, Date.now() + 120_000);
  try {
    const swept = verifier.sweepExpiredResources(new Date(), 10_000, 100);
    assert.equal(swept.failures.length, 0);
    assert.equal(swept.removedContainers, 1);
    assert.equal(swept.removedVolumes, 1);
    assert.equal(dockerExists("container", expired.container), false);
    assert.equal(dockerExists("volume", expired.volume), false);
    assert.equal(dockerExists("container", active.container), true);
    assert.equal(dockerExists("volume", active.volume), true);
  } finally {
    spawnSync("docker", ["rm", "--force", active.container], { stdio: "ignore" });
    spawnSync("docker", ["volume", "rm", "--force", active.volume], { stdio: "ignore" });
    spawnSync("docker", ["rm", "--force", expired.container], { stdio: "ignore" });
    spawnSync("docker", ["volume", "rm", "--force", expired.volume], { stdio: "ignore" });
  }
});

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function resourceContext() {
  return { jobId: randomUUID(), owner: "docker-test-worker", epoch: 1,
    deadlineAt: new Date(Date.now() + 120_000).toISOString() };
}
function dockerIds(args: string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function proposalVariant(identity: Omit<FixProposal, "id" | "proposalHash">, testPatch: string): FixProposal {
  const variant = { ...identity, testPatch, testPatchHash: sha(testPatch) };
  const proposalHash = fingerprint(variant);
  return { ...variant, proposalHash, id: fingerprint({ runId: variant.runId, revision: variant.revision, proposalHash }) };
}

function addedTestPatch(path: string, lines: readonly string[]): string {
  return [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`), ""].join("\n");
}

async function createCrashedResources(image: string, deadlineMs: number): Promise<{ container: string; volume: string }> {
  const jobId = randomUUID(); const token = randomUUID().slice(0, 8); const suffix = `${jobId.replaceAll("-", "")}-1-${token}`;
  const container = `pr-agent-fix-phase-${suffix}`; const volume = `pr-agent-fix-snapshot-${suffix}`;
  const labels = ["pr-agent.fix-verifier=true", "pr-agent.fix-verifier-version=1",
    `pr-agent.fix-verifier-job=${jobId}`, `pr-agent.fix-verifier-owner=${sha("crashed-controller")}`,
    "pr-agent.fix-verifier-epoch=1", `pr-agent.fix-verifier-deadline-ms=${deadlineMs}`];
  const script = `const{spawnSync}=require('node:child_process');const l=JSON.parse(process.env.LABELS);`+
    `const a=l.flatMap(x=>['--label',x]);let r=spawnSync('docker',['volume','create',...a,process.env.VOLUME],{stdio:'ignore'});`+
    `if(r.status)process.exit(2);r=spawnSync('docker',['run','-d','--name',process.env.CONTAINER,...a,'--network','none',`+
    `'--mount','type=volume,src='+process.env.VOLUME+',dst=/orphan','--entrypoint','node',process.env.IMAGE,`+
    `'-e','setInterval(()=>{},1000)'],{stdio:'ignore'});if(r.status)process.exit(3);process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: process.env.PATH ?? "", LABELS: JSON.stringify(labels), VOLUME: volume, CONTAINER: container, IMAGE: image,
  } });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); if (output.includes("ready\n")) resolve(); });
    child.once("exit", (code) => reject(new Error(`orphan controller exited early (${code})`)));
    child.once("error", reject);
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  return { container, volume };
}

function dockerExists(type: "container" | "volume", name: string): boolean {
  const args = type === "volume" ? ["volume", "inspect", name] : ["inspect", name];
  return spawnSync("docker", args, { stdio: "ignore", timeout: 10_000 }).status === 0;
}
