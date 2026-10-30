const SIMILAR_ISSUE_COMMAND_RE =
  /^\/(?:similar[_-]?issue|ai-review\s+similar[_-]?issue)(?:\s+([\s\S]+))?\s*$/i;
const FEEDBACK_COMMAND_RE =
  /^\/(?:feedback|ai-review\s+feedback)\s+(resolved|dismissed|up|down)(?:\s+([\s\S]+))?\s*$/i;
const SCAN_REPO_DISCUSSIONS_COMMAND_RE =
  /^\/(?:scan[_-]?repo[_-]?discussions|ai-review\s+scan[_-]?repo[_-]?discussions)\s*$/i;

export function parseSimilarIssueCommand(rawBody: string): {
  matched: boolean;
  query: string;
} {
  const body = rawBody.trim();
  const matched = body.match(SIMILAR_ISSUE_COMMAND_RE);
  if (!matched) {
    return { matched: false, query: "" };
  }

  return {
    matched: true,
    query: matched[1]?.trim() ?? "",
  };
}

export function parseFeedbackCommand(rawBody: string): {
  matched: boolean;
  action: "resolved" | "dismissed" | "up" | "down";
  note: string;
} {
  const body = rawBody.trim();
  const matched = body.match(FEEDBACK_COMMAND_RE);
  if (!matched) {
    return { matched: false, action: "up", note: "" };
  }

  const actionRaw = (matched[1] ?? "").toLowerCase();
  const action: "resolved" | "dismissed" | "up" | "down" =
    actionRaw === "resolved" ||
    actionRaw === "dismissed" ||
    actionRaw === "down"
      ? actionRaw
      : "up";

  return {
    matched: true,
    action,
    note: matched[2]?.trim() ?? "",
  };
}

export function parseScanRepoDiscussionsCommand(rawBody: string): { matched: boolean } {
  return { matched: SCAN_REPO_DISCUSSIONS_COMMAND_RE.test(rawBody.trim()) };
}
