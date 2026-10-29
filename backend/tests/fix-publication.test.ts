import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import type { PublicationBinding } from "../src/agent-runtime/authority/publication-authority.js";
import type { PublicationOperation } from "../src/agent-runtime/publication/publication.js";
import type { FixProposal, VerificationResult } from "../src/fix/contracts.js";
import { createFixPublicationAdapter } from "../src/fix/fix-publication-adapter.js";
import { buildFixPublicationPlan } from "../src/fix/publication-plan.js";

const hash = (char: string) => char.repeat(64);
const headSha = "a".repeat(40);
const proposal: FixProposal = {
  id: "proposal-1", tenantId: "11111111-1111-4111-8111-111111111111", integrationId: "22222222-2222-4222-8222-222222222222",
  runId: "33333333-3333-4333-8333-333333333333", sourceReviewRunId: "44444444-4444-4444-8444-444444444444",
  findingId: hash("f"), revision: 1, repository: "acme/widgets", baseSha: "b".repeat(40), headSha,
  sourceBundleRef: `snapshot:${hash("1")}`, sourceBundleHash: hash("1"),
  codePatch: "diff --git a/src/add.ts b/src/add.ts\n--- a/src/add.ts\n+++ b/src/add.ts\n@@ -1,3 +1,3 @@\n export function add(a: number, b: number) {\n-  return a - b;\n+  return a + b;\n }\n",
  testPatch: "diff --git a/tests/add.fix.test.ts b/tests/add.fix.test.ts\nnew file mode 100644\n--- /dev/null\n+++ b/tests/add.fix.test.ts\n@@ -0,0 +1,1 @@\n+test('add', () => assert.equal(add(1, 2), 3));\n",
  codePatchHash: "", testPatchHash: "", proposalHash: hash("4"), policyId: "node-v1", policyHash: hash("5"),
  trustedCommandHash: hash("6"), dependencyLockHash: hash("7"), dependencyLockPath: "package-lock.json",
  sandboxPolicyHash: hash("8"), imageDigest: `sha256:${hash("9")}`, publisherPolicyHash: hash("a"), qualificationStatus: "verified",
};
proposal.codePatchHash = createHash("sha256").update(proposal.codePatch).digest("hex");
proposal.testPatchHash = createHash("sha256").update(proposal.testPatch).digest("hex");
const verification: VerificationResult = {
  outcome: "verified", reasonCodes: [], baselineTarget: "fail", patchedTarget: "pass", baselineRegression: [], patchedRegression: [],
  relevance: "verified", relevanceAttestation: { kind: "trusted_checker", testPatchHash: proposal.testPatchHash, attestationHash: hash("b") },
  logRefs: {}, logHashes: { baselineTarget: hash("1"), patchedTarget: hash("2"),
    baselineRegression: hash("3"), patchedRegression: hash("4") },
  imageDigest: proposal.imageDigest, policyHash: proposal.policyHash, proposalHash: proposal.proposalHash,
};
const files = new Map([["src/add.ts", "export function add(a: number, b: number) {\n  return a - b;\n}\n"]]);

test("fix publication plan freezes branch, atomic change set, and targets the original head branch", () => {
  const plan = buildFixPublicationPlan(proposal, { platform: "github", repository: proposal.repository,
    number: 42, headBranch: "feature/math", headSha }, files, verification, verification.relevanceAttestation!);
  assert.equal(plan.operations.length, 3);
  assert.deepEqual(plan.operations.map(({ operationType }) => operationType), ["fix_branch", "fix_commit", "fix_draft_pr"]);
  assert.equal(plan.operations[2]!.payload.baseBranch, "feature/math");
  assert.equal(plan.operations[2]!.payload.draft, true);
  assert.equal((plan.operations[1]!.payload.changes as unknown[]).length, 2);
  assert.equal(plan.intent.orderedOperationPlanHash, plan.orderedOperationPlanHash);
  assert.equal(plan.intent.publishBaseSha, headSha);
  assert.equal(buildFixPublicationPlan(proposal, plan.intent.original, files, verification, verification.relevanceAttestation!).orderedOperationPlanHash,
    plan.orderedOperationPlanHash);
});

test("human relevance receipt can qualify technically passing suggestion-only verification", () => {
  const observed = { ...verification, outcome: "suggestion_only" as const, relevance: "unknown" as const,
    relevanceAttestation: undefined };
  const human = { kind: "human" as const, testPatchHash: proposal.testPatchHash, attestationHash: hash("e") };
  const plan = buildFixPublicationPlan(proposal, { platform: "github", repository: proposal.repository,
    number: 42, headBranch: "feature/math", headSha }, files, observed, human);
  assert.match(plan.intent.relevanceAttestationHash, /^[a-f0-9]{64}$/);
});

test("GitHub fix commit uses one GraphQL mutation with expected head and base64 additions", async () => {
  const binding = githubBinding();
  const plan = buildFixPublicationPlan(proposal, { platform: "github", repository: proposal.repository,
    number: 42, headBranch: "feature/math", headSha }, files, verification, verification.relevanceAttestation!);
  const operation = makeOperation(binding, plan.operations[1]!);
  const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
  const adapter = createFixPublicationAdapter({ binding, token: "test-token", operation,
    verifyCredentialIdentity: async () => ({ actorId: 77, kind: "user-token" }),
    fetchImpl: async (input, init) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "GET" && url.endsWith("/repos/acme/widgets/pulls/42")) {
        return Response.json({ head: { sha: headSha, ref: "feature/math", repo: { id: 9001, full_name: "acme/widgets" } }, base: { repo: { id: 9001 } } });
      }
      if ((init?.method ?? "GET") === "GET" && url.includes("/git/ref/heads/")) return Response.json({ object: { sha: "c".repeat(40) } });
      if ((init?.method ?? "GET") === "GET" && url.includes(`/commits/${"c".repeat(40)}`)) return Response.json({
        commit: { message: `${String(plan.operations[1]!.payload.commitMessage)}\n\n${operation.marker}` }, author: { id: 77 },
        parents: [{ sha: headSha }], files: (plan.operations[1]!.payload.changes as Array<{path:string;action:string}>).map((f) => ({ filename: f.path, status: f.action === "create" ? "added" : "modified" })),
      });
      if ((init?.method ?? "GET") === "GET" && url.includes("/contents/")) {
        const change = (plan.operations[1]!.payload.changes as Array<{path:string;contentBase64:string}>).find((f) => url.includes(f.path.replaceAll("/", "/")))!;
        return Response.json({ encoding: "base64", content: change.contentBase64 });
      }
      writes.push({ url, body: JSON.parse(String(init?.body)) });
      return Response.json({ data: { createCommitOnBranch: { commit: { oid: "c".repeat(40), message: "ok" }, ref: { name: plan.branchName } } } });
    },
  });
  const result = await adapter.dispatch(operation.marker, operation.payload!, operation);
  assert.equal(result.id, "c".repeat(40)); assert.equal(writes.length, 1); assert.equal(writes[0]!.url, "https://api.github.test/graphql");
  const variables = writes[0]!.body.variables as { input: { expectedHeadOid: string; branch: { refName: string }; fileChanges: { additions: unknown[] } } };
  assert.equal(variables.input.expectedHeadOid, headSha); assert.equal(variables.input.branch.refName, plan.branchName);
  assert.equal(variables.input.fileChanges.additions.length, 2);
});

test("GitLab publication remains suggestion-only without conditional branch creation", () => {
  assert.throws(() => buildFixPublicationPlan(proposal, { platform: "gitlab", repository: proposal.repository,
    number: 42, headBranch: "feature/math", headSha }, files, verification, verification.relevanceAttestation!), /suggestion-only/);
});

test("provider preflight rejects a fork before a mutation", async () => {
  const binding = githubBinding();
  const plan = buildFixPublicationPlan(proposal, { platform: "github", repository: proposal.repository,
    number: 42, headBranch: "feature/math", headSha }, files, verification, verification.relevanceAttestation!);
  const operation = makeOperation(binding, plan.operations[0]!); let writes = 0;
  const adapter = createFixPublicationAdapter({ binding, token: "test-token", operation,
    verifyCredentialIdentity: async () => ({ actorId: 77, kind: "user-token" }), fetchImpl: async (_input, init) => {
      if (init?.method) writes += 1;
      return Response.json({ head: { sha: headSha, ref: "feature/math", repo: { id: 123, full_name: "fork/widgets" } }, base: { repo: { id: 9001 } } });
    } });
  await assert.rejects(adapter.dispatch(operation.marker, operation.payload!, operation), /same_repository/);
  assert.equal(writes, 0);
});

function githubBinding(): PublicationBinding {
  return { id: proposal.integrationId, tenantId: proposal.tenantId, platform: "github", origin: "https://api.github.test",
    repository: proposal.repository, providerRepositoryId: 9001, providerActorId: 77, credentialRef: "env:GITHUB_TOKEN",
    generation: 2, version: 1, state: "active" };
}
function makeOperation(binding: PublicationBinding, planned: { operationType: PublicationOperation["operationType"]; slot: string; payload: Record<string, unknown> }): PublicationOperation {
  return { operationType: planned.operationType, businessOperationId: hash("c"), marker: `<!-- pr-agent-operation:${hash("c")} -->`,
    scope: { tenantId: binding.tenantId, integrationId: binding.id, platform: binding.platform, origin: binding.origin,
      repository: binding.repository, target: "42", revision: headSha, authorityGeneration: binding.generation },
    slot: planned.slot, payloadHash: hash("d"), payload: planned.payload, status: "prepared", attemptCount: 0, version: 1 };
}

test("a human receipt cannot override crashed or zero-test regression evidence", () => {
  const human = { kind: "human" as const,testPatchHash: proposal.testPatchHash,attestationHash: hash("e") };
  for (const reason of ["baseline_regression_did_not_pass","patched_regression_did_not_pass","patched_regression_executed_no_tests"]) {
    assert.throws(() => buildFixPublicationPlan(proposal,{platform:"github",repository:proposal.repository,
      number:42,headBranch:"feature/math",headSha},files,{...verification,reasonCodes:[reason]},human),/qualified/);
  }
});

test("GitHub successful HTTP with wrong branch SHA remains indeterminate after exactly one write", async () => {
  const binding = githubBinding();
  const plan = buildFixPublicationPlan(proposal,{platform:"github",repository:proposal.repository,
    number:42,headBranch:"feature/math",headSha},files,verification,verification.relevanceAttestation!);
  const operation = makeOperation(binding,plan.operations[0]!);
  let writes = 0;
  const adapter = createFixPublicationAdapter({binding,token:"fixture",operation,
    verifyCredentialIdentity:async()=>({actorId:77,kind:"user-token"}),
    fetchImpl:async(input,init)=>{
      if (init?.method === "POST") { writes++; return Response.json({ref:`refs/heads/${plan.branchName}`,object:{sha:"d".repeat(40)}}); }
      if (String(input).includes("/git/ref/")) return Response.json({ref:`refs/heads/${plan.branchName}`,object:{sha:"d".repeat(40)}});
      return Response.json({head:{sha:headSha,ref:"feature/math",repo:{id:9001,full_name:proposal.repository}},base:{repo:{id:9001}}});
    }});
  await assert.rejects(adapter.dispatch(operation.marker,operation.payload!,operation),/lookup|indeterminate/);
  assert.equal(writes,1);
});

test("provider chunked responses are cancelled at the byte cap before JSON parsing", async () => {
  const binding = githubBinding();
  const plan = buildFixPublicationPlan(proposal,{platform:"github",repository:proposal.repository,
    number:42,headBranch:"feature/math",headSha},files,verification,verification.relevanceAttestation!);
  const operation = makeOperation(binding,plan.operations[0]!);
  let cancelled = false;
  const adapter = createFixPublicationAdapter({binding,token:"fixture",operation,
    verifyCredentialIdentity:async()=>({actorId:77,kind:"user-token"}),
    fetchImpl:async()=>new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1024*1024)); },
      cancel() { cancelled = true; },
    }))});
  await assert.rejects(adapter.preflight!(operation.marker,operation.payload!),/too large/);
  assert.equal(cancelled,true);
});
