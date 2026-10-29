import { createHash } from "node:crypto";

import type { PublicationBinding } from "../../agent-runtime/authority/publication-authority.js";
import {
  buildPublicationIdentity, PublicationDefiniteFailureError, PublicationLookupIndeterminateError, PublicationPreflightError,
  type PublicationAdapter, type PublicationOperation, type PublicationPayload, type PublicationRemoteResult,
} from "../../agent-runtime/publication/publication.js";
import { assertPublicationWriteAllowed } from "../../agent-runtime/authority/write-boundary.js";
import type { GitHubCredentialIdentityVerifier } from "../../integrations/github/publication/contracts.js";

interface Change { path: string; action: "create" | "update"; contentBase64: string; contentSha256: string }
interface FixTarget {
  platform: "github" | "gitlab"; repository: string; number: number; originalHeadBranch: string;
  originalHeadSha: string; branchName: string; proposalHash: string;
}

export function createFixPublicationAdapter(params: {
  binding: PublicationBinding;
  token: string;
  operation: PublicationOperation;
  verifyCredentialIdentity?: GitHubCredentialIdentityVerifier;
  fetchImpl?: typeof fetch;
}): PublicationAdapter {
  if ((params.operation.operationType ?? "publication") === "publication") throw new Error("fix adapter requires a fix operation");
  if (params.binding.platform === "gitlab") throw new Error("GitLab fix publication is disabled because conditional branch creation is unavailable");
  const request = params.fetchImpl ?? fetch;
  return {
    preflight: (_marker, payload) => verifyPreflight(params, request, payload),
    currentRevision: async () => (await readOriginal(params, request, params.operation.payload ?? {})).originalHeadSha,
    dispatch: async (marker, payload, operation) => {
      assertPublicationWriteAllowed(params.binding.platform);
      await verifyPreflight(params, request, payload);
      const result = await dispatchGitHub(params, request, marker, payload, operation);
      const verified = await findGitHub(params, request, marker, payload, operation);
      if (!verified || String(verified.id) !== String(result.id)) throw new Error("fix provider 2xx postcondition is unverified");
      return { ...result, evidence: { ...result.evidence, postconditionVerified: true } };
    },
    find: async (marker, payload, operation) => {
      try {
        await verifyPreflight(params, request, payload);
        return await findGitHub(params, request, marker, payload, operation);
      } catch (cause) {
        if (cause instanceof PublicationLookupIndeterminateError) throw cause;
        const code = cause instanceof PublicationPreflightError ? cause.code : "fix_provider_lookup_failed";
        throw new PublicationLookupIndeterminateError(code, { cause });
      }
    },
  };
}

async function verifyPreflight(params: Parameters<typeof createFixPublicationAdapter>[0], request: typeof fetch, payload: PublicationPayload): Promise<void> {
  const target = readTarget(payload);
  const id = params.operation.businessOperationId;
  const expectedKind = `${params.binding.platform}-${params.operation.operationType?.replaceAll("_", "-")}`;
  if (payload.kind !== expectedKind) throw new PublicationPreflightError(id, "fix_operation_kind_mismatch");
  if (target.platform !== params.binding.platform || target.repository.toLowerCase() !== params.binding.repository.toLowerCase()
      || params.operation.scope.repository.toLowerCase() !== params.binding.repository.toLowerCase()
      || params.operation.scope.target !== String(target.number) || params.operation.scope.revision !== target.originalHeadSha
      || params.operation.scope.integrationId !== params.binding.id || params.operation.scope.tenantId !== params.binding.tenantId
      || params.operation.scope.authorityGeneration !== params.binding.generation) {
    throw new PublicationPreflightError(id, "fix_binding_or_scope_mismatch");
  }
  if (params.binding.platform === "github") {
    const identity = await params.verifyCredentialIdentity?.();
    if (!identity || identity.actorId !== params.binding.providerActorId) throw new PublicationPreflightError(id, "github_credential_actor_mismatch");
  }
  const original = await readOriginal(params, request, payload);
  if (original.originalHeadSha !== target.originalHeadSha || original.originalHeadBranch !== target.originalHeadBranch) {
    throw new PublicationDefiniteFailureError(id, "fix_original_head_changed");
  }
}

async function readOriginal(params: Parameters<typeof createFixPublicationAdapter>[0], request: typeof fetch, payload: PublicationPayload): Promise<FixTarget> {
  const target = readTarget(payload);
  if (params.binding.platform === "github") {
    const [owner, repo] = splitRepository(target.repository);
    const pull = await json(params, request, `${params.binding.origin}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${target.number}`) as {
      head?: { sha?: string; ref?: string; repo?: { id?: number; full_name?: string } }; base?: { repo?: { id?: number } };
    };
    if (pull.head?.repo?.id !== params.binding.providerRepositoryId || pull.base?.repo?.id !== params.binding.providerRepositoryId
        || pull.head.repo.full_name?.toLowerCase() !== target.repository.toLowerCase()) {
      throw new PublicationPreflightError(params.operation.businessOperationId, "github_fix_requires_same_repository");
    }
    return { ...target, originalHeadSha: requiredText(pull.head.sha), originalHeadBranch: requiredText(pull.head.ref) };
  }
  const project = encodeURIComponent(String(params.binding.providerRepositoryId));
  const [user, mr] = await Promise.all([
    json(params, request, `${params.binding.origin}/api/v4/user`) as Promise<{ id?: number }>,
    json(params, request, `${params.binding.origin}/api/v4/projects/${project}/merge_requests/${target.number}`) as Promise<{
      source_project_id?: number; target_project_id?: number; source_branch?: string; sha?: string; diff_refs?: { head_sha?: string };
    }>,
  ]);
  if (user.id !== params.binding.providerActorId) throw new PublicationPreflightError(params.operation.businessOperationId, "gitlab_credential_actor_mismatch");
  if (mr.source_project_id !== params.binding.providerRepositoryId || mr.target_project_id !== params.binding.providerRepositoryId) {
    throw new PublicationPreflightError(params.operation.businessOperationId, "gitlab_fix_requires_same_repository");
  }
  return { ...target, originalHeadBranch: requiredText(mr.source_branch), originalHeadSha: requiredText(mr.diff_refs?.head_sha ?? mr.sha) };
}

async function dispatchGitHub(params: Parameters<typeof createFixPublicationAdapter>[0], request: typeof fetch, marker: string,
  payload: PublicationPayload, operation: PublicationOperation): Promise<PublicationRemoteResult> {
  const target = readTarget(payload); const [owner, repo] = splitRepository(target.repository);
  if (operation.operationType === "fix_branch") {
    const result = await writeJson(params, request, `${params.binding.origin}/repos/${owner}/${repo}/git/refs`, "POST",
      { ref: `refs/heads/${target.branchName}`, sha: target.originalHeadSha }, operation) as { ref?: string; object?: { sha?: string } };
    return { id: requiredText(result.ref), evidence: { headSha: requiredText(result.object?.sha) } };
  }
  if (operation.operationType === "fix_commit") {
    const changes = readChanges(payload);
    const query = `mutation CreateFixCommit($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid message } ref { name target { oid } } } }`;
    const result = await writeJson(params, request, githubGraphqlUrl(params.binding.origin), "POST", { query, variables: { input: {
      branch: { repositoryNameWithOwner: target.repository, refName: target.branchName }, expectedHeadOid: target.originalHeadSha,
      message: { headline: requiredText(payload.commitMessage).split("\n")[0]!,
        body: `${requiredText(payload.commitMessage).split("\n").slice(2).join("\n")}\n\n${marker}` },
      fileChanges: { additions: changes.map((file) => ({ path: file.path, contents: file.contentBase64 })) },
      clientMutationId: operation.businessOperationId,
    } } }, operation) as { data?: { createCommitOnBranch?: { commit?: { oid?: string; message?: string } } }; errors?: unknown[] };
    // GraphQL may return errors alongside partial mutation data; reconcile before any retry.
    if (result.errors?.length) throw new Error("github GraphQL commit result requires reconciliation");
    return { id: requiredText(result.data?.createCommitOnBranch?.commit?.oid), evidence: { markerHash: sha256(marker), changeSetHash: sha256(JSON.stringify(changes)) } };
  }
  const ref = await optionalJson(params, request, `${params.binding.origin}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(target.branchName)}`) as { object?: { sha?: string } } | null;
  if (!ref || ref.object?.sha === target.originalHeadSha) throw new PublicationDefiniteFailureError(operation.businessOperationId, "github_fix_commit_missing_before_pr");
  await verifyGitHubCommit(params, request, target, requiredText(ref.object?.sha), readChanges(payload), requiredText(payload.expectedCommitMessage), expectedCommitMarker(operation,payload));
  const result = await writeJson(params, request, `${params.binding.origin}/repos/${owner}/${repo}/pulls`, "POST", {
    title: requiredText(payload.title), body: `${requiredText(payload.body)}\n\n${marker}`, head: target.branchName,
    base: requiredText(payload.baseBranch), draft: true,
  }, operation) as { id?: number; number?: number; draft?: boolean };
  return { id: requiredNumber(result.id), evidence: { number: requiredNumber(result.number), draft: result.draft === true } };
}

async function findGitHub(params: Parameters<typeof createFixPublicationAdapter>[0], request: typeof fetch, marker: string,
  payload: PublicationPayload, operation: PublicationOperation): Promise<PublicationRemoteResult | null> {
  const target = readTarget(payload); const [owner, repo] = splitRepository(target.repository);
  if (operation.operationType === "fix_branch") {
    const ref = await optionalJson(params, request, `${params.binding.origin}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(target.branchName)}`) as { ref?: string; object?: { sha?: string } } | null;
    if (!ref) return null;
    if (ref.object?.sha !== target.originalHeadSha) throw new PublicationLookupIndeterminateError("github_fix_branch_head_mismatch");
    return { id: requiredText(ref.ref), evidence: { headSha: ref.object.sha } };
  }
  if (operation.operationType === "fix_commit") {
    const ref = await optionalJson(params, request, `${params.binding.origin}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(target.branchName)}`) as { object?: { sha?: string } } | null;
    if (!ref) return null;
    const sha = requiredText(ref.object?.sha);
    if (sha === target.originalHeadSha) return null;
    await verifyGitHubCommit(params, request, target, sha, readChanges(payload), requiredText(payload.commitMessage), marker);
    return { id: sha, evidence: { markerHash: sha256(marker) } };
  }
  const pulls = await json(params, request, `${params.binding.origin}/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${target.branchName}`)}&base=${encodeURIComponent(requiredText(payload.baseBranch))}&per_page=100`) as Array<{
    id?: number; body?: string; draft?: boolean; user?: { id?: number }; head?: { ref?: string; sha?: string }; base?: { ref?: string };
  }>;
  const found = pulls.find((pull) => pull.body?.includes(marker)); if (!found) return null;
  const expectedBody = `${requiredText(payload.body)}\n\n${marker}`;
  if (!found.draft || found.user?.id !== params.binding.providerActorId || found.head?.ref !== target.branchName
      || found.base?.ref !== payload.baseBranch || found.body !== expectedBody) throw new PublicationLookupIndeterminateError("github_fix_pr_identity_mismatch");
  await verifyGitHubCommit(params, request, target, requiredText(found.head?.sha), readChanges(payload), requiredText(payload.expectedCommitMessage), expectedCommitMarker(operation,payload));
  return { id: requiredNumber(found.id), evidence: { draft: true, headSha: found.head?.sha } };
}

function expectedCommitMarker(operation: PublicationOperation, payload: PublicationPayload): string {
  const expected = payload.expectedCommitPayload;
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) throw new Error("approved commit intent is missing");
  return buildPublicationIdentity({ scope: operation.scope,operationType: "fix_commit",slot: "fix.commit",
    payload: expected as Record<string,unknown> }).marker;
}

async function verifyGitHubCommit(params: Parameters<typeof createFixPublicationAdapter>[0], request: typeof fetch,
  target: FixTarget, sha: string, changes: readonly Change[], message: string, marker?: string): Promise<void> {
  const [owner, repo] = splitRepository(target.repository);
  const commit = await json(params, request, `${params.binding.origin}/repos/${owner}/${repo}/commits/${sha}?per_page=100&page=1`) as {
    commit?: { message?: string }; author?: { id?: number }; parents?: Array<{ sha?: string }>;
    files?: Array<{ filename?: string; status?: string }>;
  };
  const expectedMessage = marker ? `${message}\n\n${marker}` : undefined;
  if ((expectedMessage ? commit.commit?.message !== expectedMessage
    : !commit.commit?.message?.startsWith(`${message}\n\n<!-- pr-agent-operation:`))
      || commit.author?.id !== params.binding.providerActorId || commit.parents?.length !== 1
      || commit.parents[0]?.sha !== target.originalHeadSha) throw new PublicationLookupIndeterminateError("github_fix_commit_identity_mismatch");
  const actual = commit.files ?? [];
  if (actual.length >= 100 || actual.length !== changes.length
      || actual.some((file) => !changes.some((change) => change.path === file.filename
        && file.status === (change.action === "create" ? "added" : "modified")))) {
    throw new PublicationLookupIndeterminateError("github_fix_commit_file_set_mismatch");
  }
  for (const file of changes) {
    const result = await json(params, request, `${params.binding.origin}/repos/${owner}/${repo}/contents/${file.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(sha)}`) as { content?: string; encoding?: string };
    if (result.encoding !== "base64" || sha256(Buffer.from(requiredText(result.content).replace(/\s/g, ""), "base64").toString("utf8")) !== file.contentSha256) {
      throw new PublicationLookupIndeterminateError("github_fix_content_mismatch");
    }
  }
}

async function json(params: Parameters<typeof createFixPublicationAdapter>[0], request: typeof fetch, url: string): Promise<unknown> {
  const response = await request(url, { headers: headers(params), redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new PublicationPreflightError(params.operation.businessOperationId, `fix_provider_read_http_${response.status}`);
  return readJson(response);
}
async function optionalJson(params: Parameters<typeof createFixPublicationAdapter>[0], request: typeof fetch, url: string): Promise<unknown | null> {
  const response = await request(url, { headers: headers(params), redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new PublicationLookupIndeterminateError(`fix_provider_lookup_http_${response.status}`);
  return readJson(response);
}
async function writeJson(params: Parameters<typeof createFixPublicationAdapter>[0], request: typeof fetch, url: string, method: "POST",
  body: unknown, operation: PublicationOperation): Promise<unknown> {
  assertPublicationWriteAllowed(params.binding.platform);
  const response = await request(url, { method, headers: { ...headers(params), "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    if ([400, 401, 403, 404, 409, 410, 422].includes(response.status)) throw new PublicationDefiniteFailureError(operation.businessOperationId, `fix_provider_http_${response.status}`, response.status);
    throw new Error(`fix provider write returned ${response.status}`);
  }
  return readJson(response);
}
async function readJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > 2 * 1024 * 1024) throw new Error("fix provider response too large");
  if (!response.body) throw new Error("fix provider response body missing");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("fix provider response too large"); }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}
function headers(params: Parameters<typeof createFixPublicationAdapter>[0]): Record<string, string> {
  return params.binding.platform === "github"
    ? { accept: "application/vnd.github+json", authorization: `Bearer ${params.token}`, "x-github-api-version": "2022-11-28" }
    : { accept: "application/json", "private-token": params.token };
}
function githubGraphqlUrl(origin: string): string {
  const url = new URL(origin); url.pathname = url.pathname.replace(/\/api\/v3\/?$/, "/api/graphql").replace(/\/$/, "") || "";
  if (!url.pathname || url.pathname === "/") url.pathname = "/graphql";
  return url.toString().replace(/\/$/, "");
}
function readTarget(payload: PublicationPayload): FixTarget {
  const platform = payload.platform; if (platform !== "github" && platform !== "gitlab") throw new Error("invalid fix platform");
  return { platform, repository: requiredText(payload.repository), number: requiredNumber(payload.originalNumber),
    originalHeadBranch: requiredText(payload.originalHeadBranch), originalHeadSha: requiredText(payload.originalHeadSha),
    branchName: requiredText(payload.branchName), proposalHash: requiredText(payload.proposalHash) };
}
function readChanges(payload: PublicationPayload): Change[] {
  if (!Array.isArray(payload.changes) || payload.changes.length === 0 || payload.changes.length > 20) throw new Error("invalid fix changes");
  return payload.changes.map((value) => {
    if (!value || typeof value !== "object") throw new Error("invalid fix change"); const item = value as Record<string, unknown>;
    const action = item.action; if (action !== "create" && action !== "update") throw new Error("invalid fix change action");
    return { path: requiredText(item.path), action, contentBase64: requiredText(item.contentBase64), contentSha256: requiredText(item.contentSha256) };
  });
}
function splitRepository(value: string): [string, string] { const parts = value.split("/"); if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("invalid GitHub repository"); return [parts[0], parts[1]]; }
function requiredText(value: unknown): string { if (typeof value !== "string" || !value) throw new Error("required text missing"); return value; }
function requiredNumber(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error("required number missing"); return Number(value); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
