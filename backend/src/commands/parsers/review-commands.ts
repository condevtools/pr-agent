import type { ReviewMode } from "../../review/contracts.js";

const REVIEW_COMMAND_RE =
  /^\/ai-review(?:\s+(report|comment))?(?:\s+--mode=(report|comment))?\s*$/i;
const IMPROVE_COMMAND_RE =
  /^\/(?:improve|ai-review\s+improve)(?:\s+([\s\S]+))?\s*$/i;
const ADD_DOC_COMMAND_RE =
  /^\/(?:add[_-]?doc|ai-review\s+add[_-]?doc)(?:\s+([\s\S]+))?\s*$/i;
const IMPROVE_COMPONENT_COMMAND_RE =
  /^\/(?:improve[_-]?component|ai-review\s+improve[_-]?component)\s+([\s\S]+)$/i;

export function parseReviewCommand(rawBody: string): {
  matched: boolean;
  mode: ReviewMode;
} {
  const matched = rawBody.trim().match(REVIEW_COMMAND_RE);
  if (!matched) return { matched: false, mode: "report" };
  const mode = matched[2]?.toLowerCase() ?? matched[1]?.toLowerCase() ?? "report";
  return { matched: true, mode: mode === "comment" ? "comment" : "report" };
}

export function parseImproveCommand(rawBody: string): {
  matched: boolean;
  focus: string;
} {
  const matched = rawBody.trim().match(IMPROVE_COMMAND_RE);
  return matched
    ? { matched: true, focus: matched[1]?.trim() ?? "" }
    : { matched: false, focus: "" };
}

export function parseAddDocCommand(rawBody: string): {
  matched: boolean;
  focus: string;
} {
  const matched = rawBody.trim().match(ADD_DOC_COMMAND_RE);
  return matched
    ? { matched: true, focus: matched[1]?.trim() ?? "" }
    : { matched: false, focus: "" };
}

export function parseImproveComponentCommand(rawBody: string): {
  matched: boolean;
  component: string;
} {
  const matched = rawBody.trim().match(IMPROVE_COMPONENT_COMMAND_RE);
  const component = matched?.[1]?.trim() ?? "";
  return component
    ? { matched: true, component }
    : { matched: false, component: "" };
}
