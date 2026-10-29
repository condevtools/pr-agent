import assert from "node:assert/strict";
import test from "node:test";

import { GitHubRepositoryReadAdapter } from "../src/integrations/github/github-repository-read-tools.js";
import { GitLabRepositoryReadAdapter } from "../src/integrations/gitlab/gitlab-repository-read-tools.js";
import {
  REPOSITORY_READ_LIMITS,
  RepositoryReadToolRegistry,
  type RepositoryReadAdapter,
} from "../src/integrations/shared/repository-read-tools.js";

const identity = { tenantId: "00000000-0000-4000-8000-000000000001",
  integrationId: "00000000-0000-4000-8000-000000000002",
  runId: "00000000-0000-4000-8000-000000000003", platform: "github" as const, repository: "acme/repo",
  baseSha: "0".repeat(40), headSha: "a".repeat(40) };

test("repository tools reject caller-controlled scope, traversal, sensitive paths, binary and symlink content", async () => {
  const adapter: RepositoryReadAdapter = {
    readFile: async (path) => ({ path, bytes: path === "src/binary.ts"
      ? Uint8Array.from([1, 0, 2]) : new TextEncoder().encode("const ok = true") }),
    readCiStatus: async () => [],
  };
  const tools = new RepositoryReadToolRegistry({ identity, changedPaths: ["src/a.ts"], adapter });
  await assert.rejects(tools.invoke("security", "read_file_range",
    { path: "src/a.ts", startLine: 1, endLine: 1, ref: "other" }), /unrecognized/i);
  await assert.rejects(tools.invoke("security", "read_file_range",
    { path: "../secret", startLine: 1, endLine: 1 }), /traversal/);
  await assert.rejects(tools.invoke("security", "read_file_range",
    { path: ".env", startLine: 1, endLine: 1 }), /sensitive/);
  await assert.rejects(tools.invoke("security", "read_file_range",
    { path: "src/binary.ts", startLine: 1, endLine: 1 }), /binary/);
  const symlink = new RepositoryReadToolRegistry({ identity, changedPaths: ["src/a.ts"],
    adapter: { readFile: async (path) => ({ path, bytes: new TextEncoder().encode("target"), mode: "120000" }),
      readCiStatus: async () => [] } });
  await assert.rejects(symlink.invoke("security", "read_file_range",
    { path: "src/a.ts", startLine: 1, endLine: 1 }), /symlink/);
});

test("repository tools bound and redact output while IDs are scope and revision specific", async () => {
  const text = `password: "plain-secret"\nconst token = "ghp_${"x".repeat(30)}";\nexport const value = 1;`;
  const adapter: RepositoryReadAdapter = { readFile: async (path) => ({ path, bytes: new TextEncoder().encode(text) }),
    readCiStatus: async () => [{ name: "test", status: "success" }] };
  const first = new RepositoryReadToolRegistry({ identity, changedPaths: ["src/a.ts"], adapter });
  const evidence = await first.invoke("security", "read_file_range", { path: "src/a.ts", startLine: 1, endLine: 3 });
  assert.equal(evidence.summary.includes("plain-secret"), false);
  assert.equal(evidence.summary.includes("ghp_"), false);
  assert.equal(evidence.summary.includes("[REDACTED]"), true);
  assert.equal(evidence.truncated, true);
  const other = new RepositoryReadToolRegistry({ identity: { ...identity, headSha: "b".repeat(40) },
    changedPaths: ["src/a.ts"], adapter });
  assert.notEqual((await other.invoke("security", "read_file_range",
    { path: "src/a.ts", startLine: 1, endLine: 3 })).id, evidence.id);
  await assert.rejects(first.invoke("security", "read_file_range", { path: "src/a.ts", startLine: 1,
    endLine: REPOSITORY_READ_LIMITS.maxRangeLines + 1 }), /file range/);
});

test("repository tools enforce changed-file, file-byte and search-result limits", async () => {
  assert.throws(() => new RepositoryReadToolRegistry({ identity,
    changedPaths: Array.from({ length: REPOSITORY_READ_LIMITS.maxChangedFiles + 1 }, (_, index) => `src/${index}.ts`),
    adapter: { readFile: async () => undefined, readCiStatus: async () => [] } }), /changed file list/);
  const oversized = new RepositoryReadToolRegistry({ identity, changedPaths: ["src/a.ts"], adapter: {
    readFile: async (path) => ({ path, bytes: new Uint8Array(REPOSITORY_READ_LIMITS.maxFileBytes + 1) }),
    readCiStatus: async () => [],
  } });
  await assert.rejects(oversized.invoke("security", "read_file_range",
    { path: "src/a.ts", startLine: 1, endLine: 1 }), /exceeds the read limit/);
  const manyMatches = new RepositoryReadToolRegistry({ identity, changedPaths: ["src/a.ts"], adapter: {
    readFile: async (path) => ({ path, bytes: new TextEncoder().encode("needle\n".repeat(100)) }),
    readCiStatus: async () => [],
  } });
  const search = await manyMatches.invoke("correctness", "search_changed_files", { query: "needle" });
  assert.equal(search.truncated, true);
  assert.equal(search.summary.includes(`matches=${REPOSITORY_READ_LIMITS.maxSearchMatches}`), true);
});

test("GitHub adapter uses only fixed-SHA GETs, rejects redirects and verifies regular-file mode", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes("/git/trees/")) return Response.json({ truncated: false,
      tree: [{ path: "src/a.ts", mode: "100644", type: "blob" }] });
    return Response.json({ type: "file", path: "src/a.ts", encoding: "base64",
      content: Buffer.from("ok").toString("base64") });
  };
  const adapter = new GitHubRepositoryReadAdapter({ apiBaseUrl: "https://api.github.test", token: "secret",
    owner: "acme", repo: "repo", headSha: "a".repeat(40), fetcher });
  assert.equal(new TextDecoder().decode((await adapter.readFile("src/a.ts"))!.bytes), "ok");
  assert.equal(calls.every((call) => call.init?.method === "GET" && call.init.redirect === "error"), true);
  assert.equal(calls.every((call) => call.url.includes("a".repeat(40))), true);
  assert.equal(calls.some((call) => call.url.includes("secret")), false);
});

test("GitLab adapter rejects symlink mode before reading file content", async () => {
  let count = 0;
  const adapter = new GitLabRepositoryReadAdapter({ baseUrl: "https://gitlab.test", token: "secret",
    projectId: 7, headSha: "b".repeat(40), fetcher: async () => {
      count += 1;
      return Response.json([{ name: "a.ts", path: "src/a.ts", type: "blob", mode: "120000" }]);
    } });
  await assert.rejects(adapter.readFile("src/a.ts"), /regular file/);
  assert.equal(count, 1);
});

test("provider response bodies are rejected before unbounded JSON parsing", async () => {
  const adapter = new GitHubRepositoryReadAdapter({ apiBaseUrl: "https://api.github.test", token: "secret",
    owner: "acme", repo: "repo", headSha: "a".repeat(40), fetcher: async () => new Response("{}", {
      headers: { "content-length": String(3 * 1024 * 1024) },
    }) });
  await assert.rejects(adapter.readFile("src/a.ts"), /exceeds the read limit/);
});

test("sensitive filename suffixes and nested secret directories never reach the adapter", async () => {
  let calls = 0;
  const tools = new RepositoryReadToolRegistry({ identity, changedPaths: [], adapter: {
    readFile: async () => { calls += 1; return undefined; }, readCiStatus: async () => [],
  } });
  for (const path of [".env.local", "credentials.json", "secret.yaml", "src/secrets/config.ts", ".env.production", "nested/id_ed25519"]) {
    await assert.rejects(tools.invoke("security", "read_file_range", { path, startLine: 1, endLine: 1 }), /sensitive/);
  }
  assert.equal(calls, 0);
});

test("literal percent-encoded path segments cannot normalize outside the repository endpoint", async () => {
  const path = "%2e%2e/%2e%2e/user";
  const urls: URL[] = [];
  const adapter = new GitHubRepositoryReadAdapter({ apiBaseUrl: "https://api.github.test", token: "secret",
    owner: "acme", repo: "repo", headSha: "a".repeat(40), fetcher: async (input) => {
      const url = new URL(String(input)); urls.push(url);
      return url.pathname.includes("/git/trees/") ? Response.json({ tree: [{ path, mode: "100644", type: "blob" }] })
        : Response.json({ type: "file", path, encoding: "base64", content: Buffer.from("ok").toString("base64") });
    } });
  await adapter.readFile(path);
  assert.equal(urls[1]!.pathname, "/repos/acme/repo/contents/%252e%252e/%252e%252e/user");
});

test("role deadline aborts the underlying fetch and stops sequential changed-file reads", async () => {
  let calls = 0;
  let aborted = 0;
  const adapter = new GitHubRepositoryReadAdapter({ apiBaseUrl: "https://api.github.test", token: "secret",
    owner: "acme", repo: "repo", headSha: "a".repeat(40), fetcher: async (_input, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => { aborted += 1; reject(init!.signal!.reason); };
        if (init?.signal?.aborted) abort(); else init!.signal!.addEventListener("abort", abort, { once: true });
      });
    } });
  const tools = new RepositoryReadToolRegistry({ identity, changedPaths: ["a.ts", "b.ts"], adapter });
  // Keep the event loop alive; AbortSignal.timeout deliberately does not do so itself.
  const keepAlive = setTimeout(() => undefined, 2_000);
  const started = Date.now();
  try {
    await assert.rejects(tools.invoke("security", "search_changed_files", { query: "x" }, AbortSignal.timeout(50)), /timeout/i);
  } finally { clearTimeout(keepAlive); }
  assert.ok(Date.now() - started < 1_000);
  assert.equal(aborted, 1); assert.equal(calls, 1);
});
