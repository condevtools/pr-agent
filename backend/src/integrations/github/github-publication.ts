import { createHash } from "node:crypto";
import {
  PublicationDefiniteFailureError,
  PublicationLookupIndeterminateError,
  PublicationPreflightError,
  type PublicationAdapter,
  type PublicationOperation,
  type PublicationPayload,
  type PublicationResult,
  type PublicationScope,
  type PublicationService,
} from "../../harness/publication.js";
import { buildManagedCommentBody, buildManagedCommentMarker } from "../shared/managed-comments.js";
import { GitHubRestApiError } from "./github-rest-client.js";
import type { GitHubReviewContext, MinimalGitHubOctokit } from "./github-review-types.js";
import type { PublicationAdapterFactory, PublicationBatchCoordinator, PublicationBatchStore } from "../../harness/publication-batches.js";
import type { PublicationBinding } from "../../harness/authority.js";
import { isDurablePublicationEnabled } from "../../harness/publication-mode.js";

const PAGE_SIZE = 100;
const PAGE_CAP = 20;

export type GitHubPublicationBinding = Omit<PublicationBinding, "platform"> & { platform: "github" };

export interface GitHubCredentialIdentity {
  actorId: number;
  kind: "user-token" | "github-app-installation";
  login?: string;
  installationId?: number;
  appId?: number;
}

export type GitHubCredentialIdentityVerifier = () => Promise<GitHubCredentialIdentity>;

export interface GitHubPublicationRuntime {
  service: PublicationService;
  scope: Omit<PublicationScope, "target" | "revision">;
  binding?: GitHubPublicationBinding;
  batchStore?: PublicationBatchStore;
  batchCoordinator?: PublicationBatchCoordinator;
  createAdapter?: PublicationAdapterFactory;
  resolveCredential?: () => Promise<string>;
  verifyCredentialIdentity?: GitHubCredentialIdentityVerifier;
  planOperation?: (operation: { slot: string; payload: Record<string, unknown> }) => void;
}

interface Target {
  owner: string;
  repo: string;
  pullNumber: number;
  targetId: number;
  providerRepositoryId: number;
  providerActorId: number;
}

export function createGitHubPublicationAdapter(params: {
  binding: GitHubPublicationBinding;
  octokit: MinimalGitHubOctokit;
  operation: PublicationOperation;
  verifyCredentialIdentity: GitHubCredentialIdentityVerifier;
}): PublicationAdapter {
  return makeAdapter(params.octokit, params.binding, params.operation, undefined, params.verifyCredentialIdentity);
}

export async function publishGitHubIssueCommentDurably(params: {
  runtime: GitHubPublicationRuntime; context: GitHubReviewContext; owner: string; repo: string;
  pullNumber: number; revision: string; slot: string; body: string; managedMarkerKey?: string;
}): Promise<PublicationResult> {
  const target = await resolveTarget(params);
  const managedTarget = params.managedMarkerKey
    ? await resolveManagedTarget(params.context.octokit, target, params.managedMarkerKey)
    : undefined;
  const payload = {
    kind: "github-issue-comment",
    ...target,
    body: params.body,
    revision: params.revision,
    managedMarkerKey: params.managedMarkerKey ?? null,
    managedTargetId: managedTarget?.id ?? null,
    managedTargetBodySha256: managedTarget?.bodySha256 ?? null,
  };
  return publishOrPlan(params.runtime, buildRequest(params, payload), makeAdapter(params.context.octokit, params.runtime.binding, undefined, payload, params.runtime.verifyCredentialIdentity));
}

export async function publishGitHubInlineCommentDurably(params: {
  runtime: GitHubPublicationRuntime; context: GitHubReviewContext; owner: string; repo: string;
  pullNumber: number; revision: string; slot: string; body: string; path: string; line: number;
  side: "LEFT" | "RIGHT";
}): Promise<PublicationResult> {
  const payload = {
    kind: "github-inline-comment",
    ...(await resolveTarget(params)),
    body: params.body, path: params.path, line: params.line, side: params.side,
    revision: params.revision,
  };
  return publishOrPlan(params.runtime, buildRequest(params, payload), makeAdapter(params.context.octokit, params.runtime.binding, undefined, payload, params.runtime.verifyCredentialIdentity));
}

export async function publishGitHubLabelsDurably(params: {
  runtime: GitHubPublicationRuntime; context: GitHubReviewContext; owner: string; repo: string;
  pullNumber: number; revision: string; slot: string; labels: string[];
}): Promise<PublicationResult> {
  const payload = {
    kind: "github-add-labels",
    ...(await resolveTarget(params)),
    labels: [...new Set(params.labels)].sort(),
    revision: params.revision,
  };
  return publishOrPlan(params.runtime, buildRequest(params, payload), makeAdapter(params.context.octokit, params.runtime.binding, undefined, payload, params.runtime.verifyCredentialIdentity));
}

function publishOrPlan(runtime: GitHubPublicationRuntime, publication: ReturnType<typeof buildRequest>, adapter: PublicationAdapter): Promise<PublicationResult> {
  if (!runtime.planOperation) {
    if (isDurablePublicationEnabled()) {
      throw new Error("durable publication must be planned as a frozen batch operation");
    }
    return runtime.service.publish(publication, adapter);
  }
  runtime.planOperation({ slot: publication.slot, payload: publication.payload });
  return Promise.resolve({ businessOperationId: "planned", marker: "", remoteId: "planned", reused: false, reconciled: false });
}

function buildRequest(
  params: { runtime: GitHubPublicationRuntime; pullNumber: number; revision: string; slot: string },
  payload: Record<string, unknown>,
) {
  return { scope: { ...params.runtime.scope, target: String(params.pullNumber), revision: params.revision }, slot: params.slot, payload };
}

async function resolveTarget(params: {
  runtime: GitHubPublicationRuntime; context: GitHubReviewContext; owner: string; repo: string; pullNumber: number;
}): Promise<Target> {
  const binding = params.runtime.binding;
  if (!binding) throw new PublicationPreflightError("unprepared", "github_binding_metadata_missing");
  const pull = await params.context.octokit.pulls.get({ owner: params.owner, repo: params.repo, pull_number: params.pullNumber });
  return {
    owner: params.owner,
    repo: params.repo,
    pullNumber: params.pullNumber,
    targetId: positiveInteger(pull.data.id, "github_pull_target_id_missing"),
    providerRepositoryId: binding.providerRepositoryId,
    providerActorId: binding.providerActorId,
  };
}

function makeAdapter(
  octokit: MinimalGitHubOctokit,
  expectedBinding?: GitHubPublicationBinding,
  expectedOperation?: PublicationOperation,
  initialPayload?: PublicationPayload,
  verifyCredentialIdentity: GitHubCredentialIdentityVerifier = missingIdentityVerifier,
): PublicationAdapter {
  return {
    preflight: async (_marker, payload) => {
      const target = readTarget(payload);
      await verifyLiveIdentity(verifyCredentialIdentity, target.providerActorId, expectedOperation?.businessOperationId);
      if (expectedOperation && expectedOperation.scope.target !== String(target.pullNumber)) {
        throw new PublicationPreflightError(expectedOperation.businessOperationId, "github_operation_target_mismatch");
      }
      if (expectedBinding && (
        target.providerRepositoryId !== expectedBinding.providerRepositoryId ||
        target.providerActorId !== expectedBinding.providerActorId ||
        `${target.owner}/${target.repo}`.toLowerCase() !== expectedBinding.repository.toLowerCase()
      )) throw new PublicationPreflightError(expectedOperation?.businessOperationId ?? "unprepared", "github_binding_payload_mismatch");
      await verifyIdentity(octokit, target, expectedOperation?.businessOperationId);
      await verifyManagedTargetFingerprint(octokit, target, payload, expectedOperation?.businessOperationId);
    },
    currentRevision: (expectedOperation?.payload ?? initialPayload) ? async () => {
      const target = readTarget(expectedOperation?.payload ?? initialPayload ?? {});
      return (await octokit.pulls.get({ owner: target.owner, repo: target.repo, pull_number: target.pullNumber })).data.head.sha;
    } : undefined,
    dispatch: (marker, payload, operation) => dispatch(octokit, marker, payload, operation, verifyCredentialIdentity),
    find: (marker, payload, operation) => find(octokit, marker, payload, operation, verifyCredentialIdentity),
  };
}

async function dispatch(octokit: MinimalGitHubOctokit, marker: string, payload: PublicationPayload, operation: PublicationOperation, verifyCredentialIdentity: GitHubCredentialIdentityVerifier) {
  const target = readTarget(payload);
  const credentialIdentity = await verifyLiveIdentity(verifyCredentialIdentity, target.providerActorId, operation.businessOperationId);
  const kind = text(payload.kind, "github_payload_kind_missing");
  try {
    if (kind === "github-add-labels") {
      const labels = stringArray(payload.labels);
      await requiredMethod(octokit.issues.addLabels, "github_add_labels_unavailable")({
        owner: target.owner, repo: target.repo, issue_number: target.pullNumber, labels, request: { retries: 0 },
      });
      return { id: labelReceipt(target, labels), evidence: evidence(target, payload, undefined, false, credentialIdentity) };
    }
    const body = renderedBody(payload, marker);
    if (kind === "github-inline-comment") {
      const result = await octokit.pulls.createReviewComment({
        owner: target.owner, repo: target.repo, pull_number: target.pullNumber, body,
        commit_id: operation.scope.revision, path: text(payload.path, "github_inline_path_missing"),
        line: positiveInteger(payload.line, "github_inline_line_missing"), side: side(payload.side), request: { retries: 0 },
      });
      return { id: remoteId(result), evidence: evidence(target, payload, body, true, credentialIdentity) };
    }
    if (kind !== "github-issue-comment") throw new Error(`unsupported GitHub publication kind: ${kind}`);
    const managedTargetId = optionalPositiveInteger(payload.managedTargetId);
    if (managedTargetId) {
      await verifyManagedTargetFingerprint(octokit, target, payload, operation.businessOperationId);
      await octokit.issues.updateComment({ owner: target.owner, repo: target.repo, comment_id: managedTargetId, body, request: { retries: 0 } });
      return { id: managedTargetId, evidence: evidence(target, payload, body, true, credentialIdentity) };
    }
    const created = await octokit.issues.createComment({ owner: target.owner, repo: target.repo, issue_number: target.pullNumber, body, request: { retries: 0 } });
    return { id: created.data.id, evidence: evidence(target, payload, body, true, credentialIdentity) };
  } catch (error) {
    throw classifyWrite(operation.businessOperationId, error);
  }
}

async function find(octokit: MinimalGitHubOctokit, marker: string, payload: PublicationPayload, operation: PublicationOperation, verifyCredentialIdentity: GitHubCredentialIdentityVerifier) {
  const target = readTarget(payload);
  const credentialIdentity = await verifyLiveIdentity(verifyCredentialIdentity, target.providerActorId, operation.businessOperationId, true);
  try {
    await verifyIdentity(octokit, target, operation.businessOperationId);
  } catch (cause) {
    if (cause instanceof PublicationPreflightError) throw new PublicationLookupIndeterminateError(cause.code, { cause });
    throw cause;
  }
  const kind = text(payload.kind, "github_payload_kind_missing");
  if (kind === "github-add-labels") {
    const result = await requiredMethod(octokit.issues.get, "github_issue_lookup_unavailable")({ owner: target.owner, repo: target.repo, issue_number: target.pullNumber });
    const actual = new Set((result.data.labels ?? []).map((label) => typeof label === "string" ? label : label.name).filter((label): label is string => Boolean(label)));
    const labels = stringArray(payload.labels);
    return labels.every((label) => actual.has(label)) ? { id: labelReceipt(target, labels), evidence: evidence(target, payload, undefined, false, credentialIdentity) } : null;
  }
  const expectedBody = normalize(renderedBody(payload, marker));
  const verify = (item: { id: number; body?: string | null; user?: { id?: number } | null; path?: string | null; line?: number | null; commit_id?: string | null }) => {
    if (item.user?.id !== target.providerActorId) throw new PublicationLookupIndeterminateError("github_marker_actor_mismatch");
    if (normalize(item.body ?? "") !== expectedBody) throw new PublicationLookupIndeterminateError("github_marker_body_mismatch");
    if (kind === "github-inline-comment" && (item.path !== payload.path || item.line !== payload.line || item.commit_id !== operation.scope.revision)) {
      throw new PublicationLookupIndeterminateError("github_marker_position_mismatch");
    }
    return { id: item.id, evidence: evidence(target, payload, item.body ?? "", true, credentialIdentity) };
  };
  if (kind === "github-inline-comment") {
    const list = requiredMethod(octokit.pulls.listReviewComments, "github_review_comment_lookup_unavailable");
    return scan((page) => list({ owner: target.owner, repo: target.repo, pull_number: target.pullNumber, per_page: PAGE_SIZE, page }).then((r) => r.data), marker, verify);
  }
  const list = requiredMethod(octokit.issues.listComments, "github_issue_comment_lookup_unavailable");
  return scan((page) => list({ owner: target.owner, repo: target.repo, issue_number: target.pullNumber, per_page: PAGE_SIZE, page }).then((r) => r.data), marker, verify);
}

async function scan<T extends { body?: string | null }>(load: (page: number) => Promise<T[]>, marker: string, verify: (item: T) => { id: string | number }) {
  for (let page = 1; page <= PAGE_CAP; page += 1) {
    const items = await load(page);
    const found = items.find((item) => item.body?.includes(marker));
    if (found) return verify(found);
    if (items.length < PAGE_SIZE) return null;
  }
  throw new PublicationLookupIndeterminateError("github_lookup_page_cap_reached");
}

function findLegacy(octokit: MinimalGitHubOctokit, target: Target, marker: string) {
  const list = requiredMethod(octokit.issues.listComments, "github_issue_comment_lookup_unavailable");
  return scan((page) => list({ owner: target.owner, repo: target.repo, issue_number: target.pullNumber, per_page: PAGE_SIZE, page }).then((r) => r.data), marker, (item) => ({ id: item.id }));
}

async function resolveManagedTarget(octokit: MinimalGitHubOctokit, target: Target, key: string): Promise<{ id: number; bodySha256: string } | undefined> {
  try {
    const found = await findLegacy(octokit, target, buildManagedCommentMarker(key));
    if (!found) return undefined;
    const list = requiredMethod(octokit.issues.listComments, "github_issue_comment_lookup_unavailable");
    for (let page = 1; page <= PAGE_CAP; page += 1) {
      const items = await list({ owner: target.owner, repo: target.repo, issue_number: target.pullNumber, per_page: PAGE_SIZE, page }).then((r) => r.data);
      const candidate = items.find((item) => item.id === Number(found.id));
      if (candidate) {
        if (candidate.user?.id !== target.providerActorId) throw new PublicationPreflightError("unprepared", "github_managed_target_actor_mismatch");
        return { id: candidate.id, bodySha256: digest(normalize(candidate.body ?? "")) };
      }
      if (items.length < PAGE_SIZE) break;
    }
    throw new PublicationPreflightError("unprepared", "github_managed_target_disappeared");
  } catch (cause) {
    if (cause instanceof PublicationPreflightError) throw cause;
    throw new PublicationPreflightError("unprepared", "github_managed_target_lookup_failed", { cause });
  }
}

async function verifyManagedTargetFingerprint(
  octokit: MinimalGitHubOctokit,
  target: Target,
  payload: PublicationPayload,
  operationId = "unprepared",
): Promise<void> {
  const targetId = optionalPositiveInteger(payload.managedTargetId);
  if (!targetId) return;
  const expectedHash = text(payload.managedTargetBodySha256, "github_managed_target_hash_missing");
  const key = text(payload.managedMarkerKey, "github_managed_marker_key_missing");
  const getComment = requiredMethod(octokit.issues.getComment, "github_managed_target_exact_lookup_unavailable");
  const { data } = await getComment({ owner: target.owner, repo: target.repo, comment_id: targetId });
  if (
    data.id !== targetId ||
    data.user?.id !== target.providerActorId ||
    !data.body?.includes(buildManagedCommentMarker(key)) ||
    digest(normalize(data.body ?? "")) !== expectedHash
  ) {
    throw new PublicationDefiniteFailureError(operationId, "github_managed_target_changed");
  }
}

async function verifyIdentity(octokit: MinimalGitHubOctokit, target: Target, operationId = "unprepared"): Promise<void> {
  const [repository, pull] = await Promise.all([
    requiredMethod(octokit.repos.get, "github_repository_lookup_unavailable")({ owner: target.owner, repo: target.repo }),
    octokit.pulls.get({ owner: target.owner, repo: target.repo, pull_number: target.pullNumber }),
  ]);
  if (repository.data.id !== target.providerRepositoryId) throw new PublicationPreflightError(operationId, "github_repository_identity_mismatch");
  if (pull.data.id !== target.targetId || pull.data.number !== target.pullNumber) throw new PublicationPreflightError(operationId, "github_pull_identity_mismatch");
}

function renderedBody(payload: PublicationPayload, marker: string): string {
  const base = text(payload.body, "github_body_missing");
  const key = optionalText(payload.managedMarkerKey);
  const body = key ? buildManagedCommentBody(base, key) : base;
  return `${body.replace(/[ \t]+$/gm, "").trimEnd()}\n\n${marker}`;
}
function normalize(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();
}

function classifyWrite(id: string, error: unknown): unknown {
  const status = error instanceof GitHubRestApiError ? error.status : errorStatus(error);
  if (status && [400, 401, 403, 404, 410, 422].includes(status)) {
    return new PublicationDefiniteFailureError(id, `github_http_${status}`, status, { cause: error });
  }
  return error;
}

function readTarget(payload: PublicationPayload): Target {
  return {
    owner: text(payload.owner, "github_owner_missing"),
    repo: text(payload.repo, "github_repo_missing"),
    pullNumber: positiveInteger(payload.pullNumber, "github_pull_number_missing"),
    targetId: positiveInteger(payload.targetId, "github_target_id_missing"),
    providerRepositoryId: positiveInteger(payload.providerRepositoryId, "github_repository_id_missing"),
    providerActorId: positiveInteger(payload.providerActorId, "github_actor_id_missing"),
  };
}

function labelReceipt(target: Target, labels: string[]): string {
  return `labels:${target.targetId}:${labels.join(",")}`;
}

function evidence(
  target: Target,
  payload: PublicationPayload,
  rendered: string | undefined,
  includeActor: boolean,
  identity: GitHubCredentialIdentity,
) {
  return {
    providerRepositoryId: target.providerRepositoryId,
    targetId: target.targetId,
    credentialKind: identity.kind,
    ...(identity.appId ? { appId: identity.appId } : {}),
    ...(identity.installationId ? { installationId: identity.installationId } : {}),
    ...(includeActor ? { actorId: identity.actorId } : {}),
    ...(rendered === undefined ? {} : { bodySha256: digest(normalize(rendered)) }),
    ...(payload.path ? {
      positionSha256: digest(JSON.stringify({
        path: payload.path,
        line: payload.line,
        side: payload.side,
        revision: payload.revision,
      })),
    } : {}),
    observedAt: new Date().toISOString(),
  };
}

async function verifyLiveIdentity(
  verifier: GitHubCredentialIdentityVerifier,
  expectedActorId: number,
  operationId = "unprepared",
  lookup = false,
): Promise<GitHubCredentialIdentity> {
  let identity: GitHubCredentialIdentity;
  try {
    identity = await verifier();
  } catch (cause) {
    if (lookup) {
      throw new PublicationLookupIndeterminateError("github_credential_identity_unavailable", { cause });
    }
    throw new PublicationPreflightError(operationId, "github_credential_identity_unavailable", { cause });
  }
  if (identity.actorId !== expectedActorId) {
    if (lookup) throw new PublicationLookupIndeterminateError("github_credential_actor_mismatch");
    throw new PublicationPreflightError(operationId, "github_credential_actor_mismatch");
  }
  return identity;
}

async function missingIdentityVerifier(): Promise<GitHubCredentialIdentity> {
  throw new Error("GitHub live credential identity verifier is required");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(code);
  return Number(value);
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error("github_labels_invalid");
  }
  return value as string[];
}

function side(value: unknown): "LEFT" | "RIGHT" {
  if (value !== "LEFT" && value !== "RIGHT") throw new Error("github_inline_side_invalid");
  return value;
}

function errorStatus(error: unknown): number | undefined {
  return error && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
}

function requiredMethod<T>(method: T | undefined, code: string): NonNullable<T> {
  if (!method) throw new Error(code);
  return method;
}

function remoteId(result: unknown): string | number {
  const data = result && typeof result === "object" && "data" in result ? result.data : result;
  if (
    !data ||
    typeof data !== "object" ||
    !("id" in data) ||
    (typeof data.id !== "string" && typeof data.id !== "number")
  ) {
    throw new Error("github_response_id_missing");
  }
  return data.id;
}
