import { BadWebhookRequestError } from "#core";
import type { GitLabMrWebhookBody, GitLabNoteWebhookBody } from "./contracts.js";

export function isGitLabBotUserName(userName: string | undefined): boolean {
  const normalized = (userName ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.endsWith("[bot]") ||
    normalized.endsWith("_bot") ||
    normalized === "gitlab-bot" ||
    normalized === "gitlab_ci_bot"
  );
}


export function buildMergeRequestPayloadFromNote(
  payload: GitLabNoteWebhookBody,
): GitLabMrWebhookBody {
  const iid =
    parsePositiveInteger(payload.merge_request?.iid) ??
    parsePositiveInteger(payload.object_attributes.noteable_iid);
  const sourceBranch =
    typeof payload.merge_request?.source_branch === "string"
      ? payload.merge_request.source_branch
      : "";
  const targetBranch =
    typeof payload.merge_request?.target_branch === "string"
      ? payload.merge_request.target_branch
      : "";
  const title =
    typeof payload.merge_request?.title === "string"
      ? payload.merge_request.title
      : "";
  const urlRaw = payload.merge_request?.url ?? payload.object_attributes.url;
  const url = typeof urlRaw === "string" ? urlRaw : "";
  if (!iid || !sourceBranch || !targetBranch || !title || !url) {
    throw new BadWebhookRequestError(
      "invalid gitlab note payload for merge request command",
    );
  }

  return {
    object_kind: "merge_request",
    event_type: payload.event_type,
    user: payload.user,
    project: payload.project,
    object_attributes: {
      action: "update",
      state: payload.merge_request?.state,
      iid,
      url,
      title,
      description: payload.merge_request?.description,
      source_branch: sourceBranch,
      target_branch: targetBranch,
    },
    merge_request: payload.merge_request,
  };
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}
