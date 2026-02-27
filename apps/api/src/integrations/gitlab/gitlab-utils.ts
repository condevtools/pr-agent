/**
 * Utility helpers extracted from gitlab-review.ts.
 *
 * Contains: env helpers, URL resolution, status mapping, token checks,
 * draft detection, bot detection, mode parsing.
 */

import {
  BadWebhookRequestError,
  parseBooleanEnv,
  readOptionalStringEnv,
} from "@mr-agent/core";
import type { ReviewMode } from "@mr-agent/review";

export function resolveGitLabBaseUrl(
  baseUrlFromEnv: string | undefined,
  projectWebUrl: string,
): string {
  const allowInsecureHttp = parseBooleanEnv(readOptionalStringEnv("ALLOW_INSECURE_GITLAB_HTTP"));
  const fromEnv = baseUrlFromEnv?.trim();
  if (fromEnv) {
    return ensureSecureGitLabBaseUrl(fromEnv.replace(/\/$/, ""), allowInsecureHttp);
  }

  try {
    const parsed = new URL(projectWebUrl);
    return ensureSecureGitLabBaseUrl(parsed.origin, allowInsecureHttp);
  } catch {
    throw new Error("Missing GITLAB_BASE_URL and cannot infer from project.web_url");
  }
}

function ensureSecureGitLabBaseUrl(
  baseUrl: string,
  allowInsecureHttp: boolean,
): string {
  if (!allowInsecureHttp && /^http:\/\//i.test(baseUrl)) {
    throw new BadWebhookRequestError(
      "Insecure HTTP GitLab base URL is not allowed by default; use HTTPS or set ALLOW_INSECURE_GITLAB_HTTP=true for local testing",
    );
  }
  return baseUrl;
}

export function requireGitLabToken(headers: Record<string, string | undefined>): string {
  const token = headers["x-gitlab-api-token"] ?? readOptionalStringEnv("GITLAB_TOKEN");
  if (!token) {
    throw new BadWebhookRequestError(
      "Missing GitLab API token (x-gitlab-api-token or GITLAB_TOKEN)",
    );
  }
  return token;
}

export function mapGitLabActionToReviewEvent(
  actionRaw: string | undefined,
): "opened" | "edited" | "synchronize" | "merged" | "ignored" {
  const action = (actionRaw ?? "").toLowerCase();
  if (action === "open" || action === "reopen") {
    return "opened";
  }
  if (action === "update") {
    return "synchronize";
  }
  if (action === "merge") {
    return "merged";
  }
  if (action === "close" || action === "closed") {
    return "ignored";
  }
  return "edited";
}

export function resolveGitLabChangeStatus(change: {
  deleted_file?: boolean;
  new_file?: boolean;
  renamed_file?: boolean;
}): string {
  if (change.deleted_file) return "removed";
  if (change.new_file) return "added";
  if (change.renamed_file) return "renamed";
  return "modified";
}

export function mapGitLabStatusToConclusion(statusRaw: string | undefined): string {
  const status = statusRaw?.trim().toLowerCase() ?? "";
  if (status === "success") return "success";
  if (status === "failed" || status === "failure") return "failure";
  if (status === "canceled" || status === "cancelled") return "cancelled";
  if (status === "skipped") return "skipped";
  if (status === "manual") return "action_required";
  if (
    status === "running" ||
    status === "pending" ||
    status === "created" ||
    status === "waiting_for_resource" ||
    status === "preparing" ||
    status === "scheduled"
  ) {
    return "pending";
  }
  return "unknown";
}

export function isGitLabBotUserName(userName: string | undefined): boolean {
  const normalized = (userName ?? "").trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.endsWith("[bot]") ||
    normalized.endsWith("_bot") ||
    normalized === "gitlab-bot" ||
    normalized === "gitlab_ci_bot"
  );
}

function isGitLabTitleDraftLike(titleRaw: string | undefined): boolean {
  const title = (titleRaw ?? "").trim().toLowerCase();
  if (!title) return false;
  return (
    title.startsWith("draft:") ||
    title.startsWith("wip:") ||
    title.startsWith("[draft]") ||
    title.startsWith("(draft)")
  );
}

export function isGitLabMergeRequestDraft(payload: {
  object_attributes: {
    draft?: boolean;
    work_in_progress?: boolean;
    title?: string;
  };
  merge_request?: {
    draft?: boolean;
    work_in_progress?: boolean;
    title?: string;
  };
}): boolean {
  return Boolean(
    payload.object_attributes.draft ||
      payload.object_attributes.work_in_progress ||
      payload.merge_request?.draft ||
      payload.merge_request?.work_in_progress ||
      isGitLabTitleDraftLike(payload.object_attributes.title) ||
      isGitLabTitleDraftLike(payload.merge_request?.title),
  );
}

export function parseMode(modeRaw: string | undefined): ReviewMode | undefined {
  if (!modeRaw?.trim()) return undefined;
  const mode = modeRaw.trim().toLowerCase();
  if (mode === "comment") return "comment";
  if (mode === "report") return "report";
  return undefined;
}
