import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { FixProposal } from "../../src/fix/contracts.js";
import { DockerFixVerifier, VerifierSandboxTimeoutError } from "../../src/fix/verification/docker-verifier.js";
import { loadFixPolicyRegistry } from "../../src/fix/proposal/policy.js";
import { expectedSandboxPolicyHash } from "../../src/fix/verification/sandbox-policy.js";
import { prepareSnapshotBundle } from "../../src/fix/persistence/snapshot-bundle.js";
import { fingerprint } from "../../src/agent-runtime/versions.js";

const imageDigest = process.env.FIX_VERIFIER_SANDBOX_IMAGE_DIGEST;

test("expired and aborted jobs stop before any Docker phase", async () => {
  const fixture = await deadlineFixture();
  const verifier = new DockerFixVerifier({ dockerBinary: "/definitely-not-a-docker-binary" });
  await assert.rejects(verifier.verify(fixture.proposal, fixture.policy,
    { ...resourceContext(), deadlineAt: new Date(Date.now() - 1).toISOString() }, undefined, fixture.bundle.content),
  VerifierSandboxTimeoutError);
  const controller = new AbortController(); const stopped = new Error("stopped fixture"); controller.abort(stopped);
  await assert.rejects(verifier.verify(fixture.proposal, fixture.policy, resourceContext(), controller.signal,
    fixture.bundle.content), (error: unknown) => error === stopped);
});

test("a slow seed is bounded by the whole verification deadline and never starts a phase", async () => {
  const fixture = await deadlineFixture();
  const root = await mkdtemp(join(tmpdir(), "pr-agent-fake-docker-"));
  const executable = join(root, "docker"); const log = join(root, "calls.log");
  const script = `#!/usr/bin/env node\nconst fs=require("node:fs");const a=process.argv.slice(2);`+
    `fs.appendFileSync(${JSON.stringify(log)},a.join(" ")+"\\n");`+
    `const n=a[a.indexOf("--name")+1]||"";if(a[0]==="run"&&n.includes("fix-seed"))setTimeout(()=>process.exit(0),4000);`+
    `else process.exit(0);\n`;
  await writeFile(executable, script); await chmod(executable, 0o700);
  const started = Date.now();
  try {
    await assert.rejects(new DockerFixVerifier({ dockerBinary: executable }).verify(fixture.proposal, fixture.policy,
      resourceContext(), undefined, fixture.bundle.content), VerifierSandboxTimeoutError);
    assert.ok(Date.now() - started < 3_000, "verification exceeded its whole-operation deadline");
    const calls = await readFile(log, "utf8");
    const seed = calls.split("\n").find((line) => line.includes("fix-seed")) ?? "";
    assert.match(seed, /--user 65532:65532/); assert.match(seed, /--pids-limit 16/);
    assert.match(seed, /--memory 128m --memory-swap 128m/); assert.match(seed, /--cpus 1/);
    assert.match(seed, /--ulimit nofile=256:256/); assert.match(seed, /--network none/);
    assert.match(seed, /--read-only/); assert.match(seed, /--cap-drop ALL/);
    assert.match(seed, /--security-opt no-new-privileges/); assert.match(seed, /--ipc none/);
    assert.doesNotMatch(calls, /fix-phase/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real Docker verifier proves differential and isolates credentials/socket/root/network", {
  skip: !imageDigest ? "set FIX_VERIFIER_SANDBOX_IMAGE_DIGEST to run the real Docker sandbox" : false,
  timeout: 120_000,
}, async () => {
    const lock = "{}\n";
    const source = `export function divide(a, b) {\n  return a / b;\n}\n`;
    const securityTest = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport fs from "node:fs";\n`+
      `test("no credential", () => assert.equal(process.env.GITHUB_TOKEN, undefined));\n`+
      `test("no docker socket", () => assert.equal(fs.existsSync("/var/run/docker.sock"), false));\n`+
      `test("root filesystem read only", () => assert.throws(() => fs.writeFileSync("/root-probe", "x")));\n`+
      `test("network has no default route", () => assert.equal(fs.readFileSync("/proc/net/route", "utf8").trim().split("\\n").length, 1));\n`;
    const resourceTest = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport fs from "node:fs";\n`+
      `import{spawn,spawnSync}from "node:child_process";\nimport{once}from "node:events";\n`+
      `const readLimit=(v2,v1)=>fs.readFileSync(fs.existsSync(v2)?v2:v1,"utf8").trim();\n`+
      `test("cgroup memory and process ceilings are enforced",()=>{`+
      `assert.equal(readLimit("/sys/fs/cgroup/memory.max","/sys/fs/cgroup/memory/memory.limit_in_bytes"),String(128*1024*1024));`+
      `assert.equal(readLimit("/sys/fs/cgroup/pids.max","/sys/fs/cgroup/pids/pids.max"),"64")});\n`+
      `test("pids ceiling rejects a bounded child saturation",async()=>{const children=[];let denied;`+
      `const sleep=fs.existsSync("/usr/bin/sleep")?"/usr/bin/sleep":"/bin/sleep";try{for(let i=0;i<128;i++){`+
      `const child=spawn(sleep,["30"],{stdio:"ignore"});const started=await new Promise(resolve=>{`+
      `child.once("spawn",()=>resolve({child}));child.once("error",error=>resolve({error}))});`+
      `if(started.error){denied=started.error.code;break}children.push(child)}}finally{`+
      `const closed=children.map(child=>child.exitCode!==null||child.signalCode!==null?Promise.resolve():once(child,"close"));`+
      `for(const child of children)child.kill("SIGKILL");await Promise.all(closed)}`+
      `assert.ok(children.length<128);assert.ok(denied==="EAGAIN"||denied==="ENOMEM")});\n`+
      `test("memory ceiling terminates a bounded allocation",()=>{const script=`+
      `"const held=[];for(let i=0;i<256;i++)held.push(Buffer.alloc(1024*1024,1));setTimeout(()=>{},1000)";`+
      `const child=spawnSync(process.execPath,["-e",script],{stdio:"ignore",timeout:3000});`+
      `assert.equal(child.error,undefined);assert.ok(child.signal!==null||child.status!==0)});\n`+
      `test("workspace tmpfs reaches its bounded ENOSPC ceiling",()=>{const stat=fs.statfsSync(".");`+
      `assert.ok(stat.bsize*stat.blocks<=64*1024*1024);const path=".resource-boundary.bin",block=Buffer.alloc(1024*1024);`+
      `let fd,code;try{fd=fs.openSync(path,"wx");for(let i=0;i<72;i++)fs.writeSync(fd,block)}catch(e){code=e.code}`+
      `finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(path)}catch{}}assert.equal(code,"ENOSPC")});\n`;
    const bundle = await prepareSnapshotBundle({ headSha: "a".repeat(40), dependencyLockHash: sha(lock), files: [
      { path: "package-lock.json", content: Buffer.from(lock) },
      { path: "package.json", content: Buffer.from('{"type":"module"}\n') },
      { path: "src/math.js", content: Buffer.from(source) },
      { path: "test/existing.test.js", content: Buffer.from(securityTest) },
      { path: "test/resource-boundaries.test.js", content: Buffer.from(resourceTest) },
    ] });
    const sandboxConfig = { nodeImageDigest: imageDigest!, deadlineMs: 20_000, maxLogBytes: 8_192,
      memoryMb: 128, cpuCount: 1, pidsLimit: 64, tmpfsMb: 64 };
    const rawPolicy = JSON.stringify({ "node-v1": {
      nodeImageDigest: imageDigest, argv: ["node", "--test", "test/existing.test.js", "test/resource-boundaries.test.js"],
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
    const result = await new DockerFixVerifier().verify(proposal, policy, resource, undefined, bundle.content);
    assert.equal(result.outcome, "suggestion_only", JSON.stringify(result));
    assert.equal(result.baselineTarget, "fail");
    assert.equal(result.patchedTarget, "pass");
    assert.deepEqual(result.baselineRegression, []);
    assert.deepEqual(result.patchedRegression, []);
    assert.equal(result.relevance, "unknown");
    assert.equal(result.relevanceAttestation, undefined);
    assert.ok(result.reasonCodes.includes("relevance_attestation_missing"));
    assert.equal(dockerIds(["ps", "-aq", "--filter", `label=pr-agent.fix-verifier-job=${resource.jobId}`]), "");
    assert.equal(dockerIds(["volume", "ls", "-q", "--filter", `label=pr-agent.fix-verifier-job=${resource.jobId}`]), "");

    const hangingPatch = addedTestPatch("test/hanging.test.js", [
      'import test from "node:test";', 'import assert from "node:assert/strict";',
      'import { divide } from "../src/math.js";',
      'test("divide hangs", () => { assert.equal(typeof divide, "function"); while (true) {} });',
    ]);
    const hanging = await new DockerFixVerifier().verify(
      proposalVariant(identity, hangingPatch), policy, resource, undefined, bundle.content);
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
    const noisy = await new DockerFixVerifier().verify(
      proposalVariant(identity, noisyPatch), policy, resource, undefined, bundle.content);
    assert.equal(noisy.outcome, "suggestion_only");
    assert.ok(Buffer.byteLength(JSON.stringify(noisy)) < 8_192);
    assert.equal(JSON.stringify(noisy).includes("x".repeat(100)), false);
    assert.equal(dockerIds(["ps", "-aq", "--filter", `label=pr-agent.fix-verifier-job=${resource.jobId}`]), "");
    assert.equal(dockerIds(["volume", "ls", "-q", "--filter", `label=pr-agent.fix-verifier-job=${resource.jobId}`]), "");
});

test("orphan sweeper reaps only expired crash leftovers and preserves active resources", {
  skip: !imageDigest ? "set FIX_VERIFIER_SANDBOX_IMAGE_DIGEST to run the real Docker sandbox" : false,
  timeout: 60_000,
}, async () => {
  const verifier = new DockerFixVerifier();
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

async function deadlineFixture() {
  const lock = "{}\n"; const headSha = "a".repeat(40);
  const bundle = await prepareSnapshotBundle({ headSha, dependencyLockHash: sha(lock), files: [
    { path: "package-lock.json", content: Buffer.from(lock) },
    { path: "src/math.js", content: Buffer.from("export const divide=(a,b)=>a/b;\n") },
  ] });
  const image = `sha256:${"b".repeat(64)}`;
  const sandboxConfig = { nodeImageDigest: image, deadlineMs: 2_000, maxLogBytes: 4_096,
    memoryMb: 128, cpuCount: 1, pidsLimit: 16, tmpfsMb: 32 };
  const rawPolicy = JSON.stringify({ fixture: { nodeImageDigest: image, argv: ["node", "--test", "test/existing.test.js"],
    dependencyLockPath: "package-lock.json", dependencyLockHash: sha(lock),
    sandboxHash: expectedSandboxPolicyHash(sandboxConfig), allowedTestPrefixes: ["test"], relevanceTokens: ["divide"],
    ...sandboxConfig, publisherPolicyId: "publisher", publisherPolicyHash: "c".repeat(64), publishEnabled: false } });
  const policy = loadFixPolicyRegistry(rawPolicy).get("fixture")!;
  const testPatch = addedTestPatch("test/divide.test.js", [
    'import test from "node:test";', 'import assert from "node:assert/strict";',
    'import { divide } from "../src/math.js";', 'test("divide",()=>assert.equal(divide(4,2),2));',
  ]);
  const identity = { tenantId: "00000000-0000-4000-8000-000000000001",
    integrationId: "00000000-0000-4000-8000-000000000002", runId: "00000000-0000-4000-8000-000000000003",
    sourceReviewRunId: "00000000-0000-4000-8000-000000000004", findingId: "d".repeat(64), revision: 1 as const,
    repository: "owner/repo", baseSha: "e".repeat(40), headSha, sourceBundleRef: bundle.sourceBundleRef,
    sourceBundleHash: bundle.sourceBundleHash, codePatch: "", testPatch, codePatchHash: sha(""), testPatchHash: sha(testPatch),
    policyId: policy.id, policyHash: policy.hash, trustedCommandHash: fingerprint(policy.argv),
    dependencyLockPath: policy.dependencyLockPath, dependencyLockHash: policy.dependencyLockHash,
    sandboxPolicyHash: policy.sandboxHash, imageDigest: policy.nodeImageDigest,
    publisherPolicyHash: policy.publisherPolicyHash, qualificationStatus: "not_verified" as const };
  const proposalHash = fingerprint(identity);
  const proposal: FixProposal = { ...identity, proposalHash,
    id: fingerprint({ runId: identity.runId, revision: identity.revision, proposalHash }) };
  return { bundle, policy, proposal };
}
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
