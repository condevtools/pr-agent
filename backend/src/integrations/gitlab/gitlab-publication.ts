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
import { gitLabApiRequest } from "./gitlab-http.js";
import type { PublicationAdapterFactory, PublicationBatchCoordinator, PublicationBatchStore } from "../../harness/publication-batches.js";
import type { PublicationBinding } from "../../harness/authority.js";
import { isDurablePublicationEnabled } from "../../harness/publication-mode.js";

const PAGE_SIZE = 100;
const PAGE_CAP = 20;

export type GitLabPublicationBinding = Omit<PublicationBinding, "platform"> & { platform: "gitlab" };

export interface GitLabPublicationRuntime {
  service: PublicationService;
  scope: Omit<PublicationScope, "target" | "revision">;
  binding?: GitLabPublicationBinding;
  batchStore?: PublicationBatchStore;
  batchCoordinator?: PublicationBatchCoordinator;
  createAdapter?: PublicationAdapterFactory;
  resolveCredential?: () => Promise<string>;
  planOperation?: (operation: { slot: string; payload: Record<string, unknown> }) => void;
}

interface GitLabTarget { baseUrl: string; projectId: number; mrId: number }
interface FrozenTarget extends GitLabTarget { targetId: number; providerRepositoryId: number; providerActorId: number; providerRepositoryPath: string }

export function createGitLabPublicationAdapter(params: {
  binding: GitLabPublicationBinding;
  token: string;
  operation: PublicationOperation;
}): PublicationAdapter {
  return makeAdapter(params.token, params.binding, params.operation);
}

export async function publishGitLabNoteDurably(params: {
  runtime: GitLabPublicationRuntime; token: string; target: GitLabTarget; revision: string;
  slot: string; body: string; managedMarkerKey?: string;
}): Promise<PublicationResult> {
  const target = await resolveTarget(params.runtime, params.token, params.target);
  const managedTarget = params.managedMarkerKey
    ? await resolveManagedTarget(params.token, target, params.managedMarkerKey)
    : undefined;
  const payload = {
    kind: "gitlab-note", ...target,
    body: params.body, managedMarkerKey: params.managedMarkerKey ?? null,
    revision: params.revision,
    managedTargetId: managedTarget?.id ?? null,
    managedTargetBodySha256: managedTarget?.bodySha256 ?? null,
  };
  return publishOrPlan(params.runtime, request(params, payload), makeAdapter(params.token, undefined, undefined, payload));
}

export async function publishGitLabDiscussionDurably(params: {
  runtime: GitLabPublicationRuntime; token: string; target: GitLabTarget; revision: string;
  slot: string; body: string; position: Record<string, unknown>;
}): Promise<PublicationResult> {
  const payload = {
    kind: "gitlab-discussion", ...(await resolveTarget(params.runtime, params.token, params.target)),
    body: params.body, position: params.position,
    revision: params.revision,
  };
  return publishOrPlan(params.runtime, request(params, payload), makeAdapter(params.token, undefined, undefined, payload));
}

export async function publishGitLabLabelsDurably(params: {
  runtime: GitLabPublicationRuntime; token: string; target: GitLabTarget; revision: string;
  slot: string; labels: string[];
}): Promise<PublicationResult> {
  const payload = {
    kind: "gitlab-add-labels", ...(await resolveTarget(params.runtime, params.token, params.target)),
    labels: [...new Set(params.labels)].sort(),
    revision: params.revision,
  };
  return publishOrPlan(params.runtime, request(params, payload), makeAdapter(params.token, undefined, undefined, payload));
}

function publishOrPlan(runtime: GitLabPublicationRuntime, publication: ReturnType<typeof request>, adapter: PublicationAdapter): Promise<PublicationResult> {
  if (!runtime.planOperation) {
    if (isDurablePublicationEnabled()) {
      throw new Error("durable publication must be planned as a frozen batch operation");
    }
    return runtime.service.publish(publication, adapter);
  }
  runtime.planOperation({ slot: publication.slot, payload: publication.payload });
  return Promise.resolve({ businessOperationId: "planned", marker: "", remoteId: "planned", reused: false, reconciled: false });
}

function request(
  params: { runtime: GitLabPublicationRuntime; target: GitLabTarget; revision: string; slot: string },
  payload: Record<string, unknown>,
) {
  return { scope: { ...params.runtime.scope, target: String(params.target.mrId), revision: params.revision }, slot: params.slot, payload };
}

async function resolveTarget(runtime: GitLabPublicationRuntime, token: string, target: GitLabTarget): Promise<FrozenTarget> {
  const binding = runtime.binding;
  if (!binding) throw new PublicationPreflightError("unprepared", "gitlab_binding_metadata_missing");
  const mr = await jsonRequest<{ id?: unknown }>(token, mrUrl(target));
  return {
    ...target,
    targetId: positiveInteger(mr.id, "gitlab_merge_request_target_id_missing"),
    providerRepositoryId: binding.providerRepositoryId,
    providerActorId: binding.providerActorId,
    providerRepositoryPath: binding.repository,
  };
}

function makeAdapter(token: string, expectedBinding?: GitLabPublicationBinding, expectedOperation?: PublicationOperation, initialPayload?: PublicationPayload): PublicationAdapter {
  return {
    preflight: async (_marker, payload) => {
      const target = readTarget(payload);
      if (expectedOperation && expectedOperation.scope.target !== String(target.mrId)) throw new PublicationPreflightError(expectedOperation.businessOperationId, "gitlab_operation_target_mismatch");
      if (expectedBinding && (target.providerRepositoryId !== expectedBinding.providerRepositoryId || target.providerActorId !== expectedBinding.providerActorId || target.projectId !== expectedBinding.providerRepositoryId)) {
        throw new PublicationPreflightError(expectedOperation?.businessOperationId ?? "unprepared", "gitlab_binding_payload_mismatch");
      }
      await verifyIdentity(token, target, expectedOperation?.businessOperationId);
      await verifyManagedTargetFingerprint(token, target, payload, expectedOperation?.businessOperationId);
    },
    currentRevision: (expectedOperation?.payload ?? initialPayload) ? async () => readHead(token, readTarget(expectedOperation?.payload ?? initialPayload ?? {})) : undefined,
    dispatch: (marker, payload, operation) => dispatch(token, marker, payload, operation),
    find: (marker, payload, operation) => find(token, marker, payload, operation),
  };
}

async function dispatch(token: string, marker: string, payload: PublicationPayload, operation: PublicationOperation) {
  const target = readTarget(payload);
  const kind = text(payload.kind, "gitlab_payload_kind_missing");
  try {
    if (kind === "gitlab-add-labels") {
      const labels = stringArray(payload.labels);
      const response = await gitLabApiRequest({ url: mrUrl(target), token, method: "PUT", body: { add_labels: labels.join(",") }, retry: false });
      await requireWriteOk(response, operation.businessOperationId);
      return { id: labelReceipt(target, labels), evidence: evidence(target, payload, undefined, false) };
    }
    const body = renderedBody(payload, marker);
    if (kind === "gitlab-discussion") {
      const response = await gitLabApiRequest({ url: discussionsUrl(target), token, method: "POST", body: { body, position: record(payload.position, "gitlab_position_missing") }, retry: false });
      return { id: await writeId(response, operation.businessOperationId), evidence: evidence(target, payload, body, true) };
    }
    if (kind !== "gitlab-note") throw new Error(`unsupported GitLab publication kind: ${kind}`);
    const managedTargetId = optionalPositiveInteger(payload.managedTargetId);
    if (managedTargetId) {
        await verifyManagedTargetFingerprint(token, target, payload, operation.businessOperationId);
        const response = await gitLabApiRequest({ url: `${notesUrl(target)}/${managedTargetId}`, token, method: "PUT", body: { body }, retry: false });
        await requireWriteOk(response, operation.businessOperationId);
        return { id: managedTargetId, evidence: evidence(target, payload, body, true) };
    }
    const response = await gitLabApiRequest({ url: notesUrl(target), token, method: "POST", body: { body }, retry: false });
    return { id: await writeId(response, operation.businessOperationId), evidence: evidence(target, payload, body, true) };
  } catch (error) {
    if (error instanceof PublicationDefiniteFailureError) throw error;
    throw error;
  }
}

async function find(token: string, marker: string, payload: PublicationPayload, operation: PublicationOperation) {
  const target = readTarget(payload);
  try {
    await verifyIdentity(token, target, operation.businessOperationId);
  } catch (cause) {
    if (cause instanceof PublicationPreflightError) throw new PublicationLookupIndeterminateError(cause.code, { cause });
    throw cause;
  }
  const kind = text(payload.kind, "gitlab_payload_kind_missing");
  if (kind === "gitlab-add-labels") {
    const mr = await jsonRequest<{ labels?: unknown }>(token, mrUrl(target));
    const actual = new Set(Array.isArray(mr.labels) ? mr.labels.filter((v): v is string => typeof v === "string") : []);
    const labels = stringArray(payload.labels);
    return labels.every((label) => actual.has(label)) ? { id: labelReceipt(target, labels), evidence: evidence(target, payload, undefined, false) } : null;
  }
  const expectedBody = normalize(renderedBody(payload, marker));
  const verify = (note: { id?: string | number; body?: string; author?: { id?: number }; position?: Record<string, unknown> }) => {
    if (note.author?.id !== target.providerActorId) throw new PublicationLookupIndeterminateError("gitlab_marker_actor_mismatch");
    if (normalize(note.body ?? "") !== expectedBody) throw new PublicationLookupIndeterminateError("gitlab_marker_body_mismatch");
    if (kind === "gitlab-discussion" && !samePosition(note.position, record(payload.position, "gitlab_position_missing"), operation.scope.revision)) throw new PublicationLookupIndeterminateError("gitlab_marker_position_mismatch");
    if (typeof note.id !== "string" && typeof note.id !== "number") throw new PublicationLookupIndeterminateError("gitlab_marker_remote_id_missing");
    return { id: note.id, evidence: evidence(target, payload, note.body ?? "", true) };
  };
  if (kind === "gitlab-discussion") {
    for (let page = 1; page <= PAGE_CAP; page += 1) {
      const discussions = await jsonRequest<Array<{ notes?: Array<{ id?: number; body?: string; author?: { id?: number }; position?: Record<string, unknown> }> }>>(token, `${discussionsUrl(target)}?per_page=${PAGE_SIZE}&page=${page}`);
      const found = discussions.flatMap((item) => item.notes ?? []).find((note) => note.body?.includes(marker));
      if (found) return verify(found);
      if (discussions.length < PAGE_SIZE) return null;
    }
    throw new PublicationLookupIndeterminateError("gitlab_lookup_page_cap_reached");
  }
  return scan((page) => jsonRequest(token, `${notesUrl(target)}?per_page=${PAGE_SIZE}&page=${page}`), marker, verify);
}

async function scan<T extends { body?: string }>(load: (page: number) => Promise<T[]>, marker: string, verify: (item: T) => { id: string | number }) {
  for (let page = 1; page <= PAGE_CAP; page += 1) {
    const items = await load(page);
    const found = items.find((item) => item.body?.includes(marker));
    if (found) return verify(found);
    if (items.length < PAGE_SIZE) return null;
  }
  throw new PublicationLookupIndeterminateError("gitlab_lookup_page_cap_reached");
}

function findLegacy(token: string, target: FrozenTarget, marker: string) {
  return scan((page) => jsonRequest<Array<{ id: number; body?: string }>>(token, `${notesUrl(target)}?per_page=${PAGE_SIZE}&page=${page}`), marker, (item) => ({ id: item.id }));
}

async function resolveManagedTarget(token: string, target: FrozenTarget, key: string): Promise<{ id: number; bodySha256: string } | undefined> {
  const marker = buildManagedCommentMarker(key);
  try {
    for (let page = 1; page <= PAGE_CAP; page += 1) {
      const notes = await jsonRequest<Array<{ id?: number; body?: string; author?: { id?: number } }>>(token, `${notesUrl(target)}?per_page=${PAGE_SIZE}&page=${page}`);
      const candidate = notes.find((note) => note.body?.includes(marker));
      if (candidate) {
        if (candidate.author?.id !== target.providerActorId) throw new PublicationPreflightError("unprepared", "gitlab_managed_target_actor_mismatch");
        if (typeof candidate.id !== "number") throw new PublicationPreflightError("unprepared", "gitlab_managed_target_id_missing");
        return { id: candidate.id, bodySha256: digest(normalize(candidate.body ?? "")) };
      }
      if (notes.length < PAGE_SIZE) return undefined;
    }
    throw new PublicationPreflightError("unprepared", "gitlab_managed_target_lookup_page_cap");
  } catch (cause) {
    if (cause instanceof PublicationPreflightError) throw cause;
    throw new PublicationPreflightError("unprepared", "gitlab_managed_target_lookup_failed", { cause });
  }
}

async function verifyManagedTargetFingerprint(
  token: string,
  target: FrozenTarget,
  payload: PublicationPayload,
  operationId = "unprepared",
): Promise<void> {
  const targetId = optionalPositiveInteger(payload.managedTargetId);
  if (!targetId) return;
  const expectedHash = text(payload.managedTargetBodySha256, "gitlab_managed_target_hash_missing");
  const key = text(payload.managedMarkerKey, "gitlab_managed_marker_key_missing");
  const note = await jsonRequest<{ id?: number; body?: string; author?: { id?: number } }>(token, `${notesUrl(target)}/${targetId}`);
  if (
    note.id !== targetId ||
    note.author?.id !== target.providerActorId ||
    !note.body?.includes(buildManagedCommentMarker(key)) ||
    digest(normalize(note.body ?? "")) !== expectedHash
  ) {
    throw new PublicationDefiniteFailureError(operationId, "gitlab_managed_target_changed");
  }
}

async function jsonRequest<T>(token: string, url: string): Promise<T> {
  const response = await gitLabApiRequest({ url, token });
  if (!response.ok) throw new Error(`GitLab read failed (${response.status})`);
  try {
    return await response.json() as T;
  } catch (cause) {
    throw new PublicationLookupIndeterminateError("gitlab_malformed_read_response", { cause });
  }
}

async function requireWriteOk(response: Response, operationId: string): Promise<void> {
  if (response.ok) return;
  if ([400, 401, 403, 404, 410, 422].includes(response.status)) {
    throw new PublicationDefiniteFailureError(
      operationId,
      `gitlab_http_${response.status}`,
      response.status,
    );
  }
  throw new Error(`GitLab write failed (${response.status})`);
}

async function writeId(response: Response, operationId: string): Promise<string | number> {
  await requireWriteOk(response, operationId);
  let body: { id?: unknown };
  try {
    body = await response.json() as { id?: unknown };
  } catch (cause) {
    throw new Error("GitLab write response was malformed", { cause });
  }
  if (typeof body.id !== "string" && typeof body.id !== "number") {
    throw new Error("GitLab write response did not include an id");
  }
  return body.id;
}

async function readHead(token: string, target: FrozenTarget): Promise<string> {
  const body = await jsonRequest<{ sha?: unknown; diff_refs?: { head_sha?: unknown } }>(
    token,
    mrUrl(target),
  );
  let revision: string | undefined;
  if (typeof body.sha === "string") {
    revision = body.sha;
  } else if (typeof body.diff_refs?.head_sha === "string") {
    revision = body.diff_refs.head_sha;
  }
  if (!revision) throw new Error("gitlab_head_revision_missing");
  return revision;
}

async function verifyIdentity(
  token: string,
  target: FrozenTarget,
  operationId = "unprepared",
): Promise<void> {
  const [user, project, mr] = await Promise.all([
    jsonRequest<{ id?: unknown }>(token, `${target.baseUrl}/api/v4/user`),
    jsonRequest<{ id?: unknown; path_with_namespace?: unknown }>(
      token,
      `${target.baseUrl}/api/v4/projects/${encodeURIComponent(target.projectId)}`,
    ),
    jsonRequest<{ id?: unknown; iid?: unknown }>(token, mrUrl(target)),
  ]);
  if (user.id !== target.providerActorId) {
    throw new PublicationPreflightError(operationId, "gitlab_actor_identity_mismatch");
  }
  if (
    project.id !== target.providerRepositoryId ||
    project.path_with_namespace !== target.providerRepositoryPath
  ) {
    throw new PublicationPreflightError(operationId, "gitlab_project_identity_mismatch");
  }
  if (mr.id !== target.targetId || mr.iid !== target.mrId) {
    throw new PublicationPreflightError(operationId, "gitlab_merge_request_identity_mismatch");
  }
}

function renderedBody(payload: PublicationPayload, marker: string): string {
  const base = text(payload.body, "gitlab_body_missing");
  const key = optionalText(payload.managedMarkerKey);
  const body = key ? buildManagedCommentBody(base, key) : base;
  return `${body.replace(/[ \t]+$/gm, "").trimEnd()}\n\n${marker}`;
}

function normalize(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();
}

function samePosition(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown>,
  revision: string,
): boolean {
  if (!actual) return false;
  const keys = [
    "base_sha",
    "start_sha",
    "head_sha",
    "new_path",
    "old_path",
    "new_line",
    "old_line",
    "position_type",
  ];
  return keys.every((key) => actual[key] === expected[key]) &&
    (expected.head_sha === undefined || expected.head_sha === revision);
}

function readTarget(payload: PublicationPayload): FrozenTarget {
  return {
    baseUrl: text(payload.baseUrl, "gitlab_base_url_missing"),
    projectId: positiveInteger(payload.projectId, "gitlab_project_id_missing"),
    mrId: positiveInteger(payload.mrId, "gitlab_mr_iid_missing"),
    targetId: positiveInteger(payload.targetId, "gitlab_target_id_missing"),
    providerRepositoryId: positiveInteger(
      payload.providerRepositoryId,
      "gitlab_provider_project_id_missing",
    ),
    providerActorId: positiveInteger(payload.providerActorId, "gitlab_actor_id_missing"),
    providerRepositoryPath: text(payload.providerRepositoryPath, "gitlab_repository_path_missing"),
  };
}

function notesUrl(target: GitLabTarget): string {
  return `${target.baseUrl}/api/v4/projects/${encodeURIComponent(target.projectId)}/merge_requests/${target.mrId}/notes`;
}

function discussionsUrl(target: GitLabTarget): string {
  return `${target.baseUrl}/api/v4/projects/${encodeURIComponent(target.projectId)}/merge_requests/${target.mrId}/discussions`;
}

function mrUrl(target: GitLabTarget): string {
  return `${target.baseUrl}/api/v4/projects/${encodeURIComponent(target.projectId)}/merge_requests/${target.mrId}`;
}

function labelReceipt(target: FrozenTarget, labels: string[]): string {
  return `labels:${target.targetId}:${labels.join(",")}`;
}

function evidence(
  target: FrozenTarget,
  payload: PublicationPayload,
  rendered: string | undefined,
  includeActor: boolean,
) {
  return {
    providerRepositoryId: target.providerRepositoryId,
    targetId: target.targetId,
    ...(includeActor ? { actorId: target.providerActorId } : {}),
    ...(rendered === undefined ? {} : { bodySha256: digest(normalize(rendered)) }),
    ...(payload.position ? { positionSha256: digest(JSON.stringify(payload.position)) } : {}),
    observedAt: new Date().toISOString(),
  };
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
    throw new Error("gitlab_labels_invalid");
  }
  return value as string[];
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}
