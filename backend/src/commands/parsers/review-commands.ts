import type { ReviewMode } from "../../review/contracts.js";

const REVIEW_COMMAND_RE =
  /^\/ai-review(?:\s+(report|comment))?(?:\s+--mode=(report|comment))?\s*$/i;
const DESCRIBE_COMMAND_RE = /^\/(?:describe|ai-review\s+describe)(?:\s+--apply)?\s*$/i;
const CHECKS_COMMAND_RE = /^\/(?:checks|ai-review\s+checks)(?:\s+([\s\S]+))?\s*$/i;
const GENERATE_TESTS_COMMAND_RE =
  /^\/(?:generate[_-]?tests|ai-review\s+generate[_-]?tests)(?:\s+([\s\S]+))?\s*$/i;
const IMPROVE_COMMAND_RE =
  /^\/(?:improve|ai-review\s+improve)(?:\s+([\s\S]+))?\s*$/i;
const ADD_DOC_COMMAND_RE =
  /^\/(?:add[_-]?doc|ai-review\s+add[_-]?doc)(?:\s+([\s\S]+))?\s*$/i;
const REFLECT_COMMAND_RE =
  /^\/(?:reflect|ai-review\s+reflect)(?:\s+([\s\S]+))?\s*$/i;
const CHANGELOG_COMMAND_RE =
  /^\/(?:changelog|ai-review\s+changelog)(?:\s+([\s\S]+))?\s*$/i;
const ANALYZE_COMMAND_RE = /^\/(?:analyze|ai-review\s+analyze)\s*$/i;
const COMPLIANCE_COMMAND_RE =
  /^\/(?:compliance|ai-review\s+compliance)(?:\s+([\s\S]+))?\s*$/i;
const IMPROVE_COMPONENT_COMMAND_RE =
  /^\/(?:improve[_-]?component|ai-review\s+improve[_-]?component)\s+([\s\S]+)$/i;
const GENERATE_LABELS_COMMAND_RE =
  /^\/(?:generate[_-]?labels|ai-review\s+generate[_-]?labels)\s*$/i;
const SIMILAR_CODE_COMMAND_RE =
  /^\/(?:similar[_-]?code|ai-review\s+similar[_-]?code)(?:\s+([\s\S]+))?\s*$/i;
const AUTO_APPROVE_COMMAND_RE = /^\/(?:auto[_-]?approve|ai-review\s+auto[_-]?approve)\s*$/i;

export function parseReviewCommand(rawBody: string): {
  matched: boolean;
  mode: ReviewMode;
} {
  const body = rawBody.trim();
  const matched = body.match(REVIEW_COMMAND_RE);
  if (!matched) {
    return { matched: false, mode: "report" };
  }

  const fromPositional = matched[1]?.toLowerCase();
  const fromFlag = matched[2]?.toLowerCase();
  const modeRaw = fromFlag ?? fromPositional ?? "report";

  return {
    matched: true,
    mode: modeRaw === "comment" ? "comment" : "report",
  };
}

export function parseDescribeCommand(rawBody: string): {
  matched: boolean;
  apply: boolean;
} {
  const body = rawBody.trim();
  if (!DESCRIBE_COMMAND_RE.test(body)) {
    return { matched: false, apply: false };
  }

  return {
    matched: true,
    apply: /\s--apply(?:\s|$)/i.test(body),
  };
}

export function parseChecksCommand(rawBody: string): {
  matched: boolean;
  question: string;
} {
  const body = rawBody.trim();
  const matched = body.match(CHECKS_COMMAND_RE);
  if (!matched) {
    return { matched: false, question: "" };
  }

  return {
    matched: true,
    question: matched[1]?.trim() ?? "",
  };
}

export function parseGenerateTestsCommand(rawBody: string): {
  matched: boolean;
  focus: string;
} {
  const body = rawBody.trim();
  const matched = body.match(GENERATE_TESTS_COMMAND_RE);
  if (!matched) {
    return { matched: false, focus: "" };
  }

  return {
    matched: true,
    focus: matched[1]?.trim() ?? "",
  };
}

export function parseImproveCommand(rawBody: string): {
  matched: boolean;
  focus: string;
} {
  const body = rawBody.trim();
  const matched = body.match(IMPROVE_COMMAND_RE);
  if (!matched) {
    return { matched: false, focus: "" };
  }

  return {
    matched: true,
    focus: matched[1]?.trim() ?? "",
  };
}

export function parseAddDocCommand(rawBody: string): {
  matched: boolean;
  focus: string;
} {
  const body = rawBody.trim();
  const matched = body.match(ADD_DOC_COMMAND_RE);
  if (!matched) {
    return { matched: false, focus: "" };
  }

  return {
    matched: true,
    focus: matched[1]?.trim() ?? "",
  };
}

export function parseReflectCommand(rawBody: string): {
  matched: boolean;
  request: string;
} {
  const body = rawBody.trim();
  const matched = body.match(REFLECT_COMMAND_RE);
  if (!matched) {
    return { matched: false, request: "" };
  }

  return {
    matched: true,
    request: matched[1]?.trim() ?? "",
  };
}

export function parseChangelogCommand(rawBody: string): {
  matched: boolean;
  apply: boolean;
  focus: string;
} {
  const body = rawBody.trim();
  const matched = body.match(CHANGELOG_COMMAND_RE);
  if (!matched) {
    return { matched: false, apply: false, focus: "" };
  }

  const args = (matched[1] ?? "").trim();
  if (!args) {
    return { matched: true, apply: false, focus: "" };
  }

  const focusParts: string[] = [];
  let apply = false;
  for (const token of args.split(/\s+/)) {
    if (!token) {
      continue;
    }
    if (/^--apply$/i.test(token)) {
      apply = true;
      continue;
    }
    focusParts.push(token);
  }

  return {
    matched: true,
    apply,
    focus: focusParts.join(" ").trim(),
  };
}

export function parseAnalyzeCommand(rawBody: string): { matched: boolean } {
  return { matched: ANALYZE_COMMAND_RE.test(rawBody.trim()) };
}

export function parseComplianceCommand(rawBody: string): {
  matched: boolean;
  focus: string;
} {
  const body = rawBody.trim();
  const matched = body.match(COMPLIANCE_COMMAND_RE);
  if (!matched) {
    return { matched: false, focus: "" };
  }
  return { matched: true, focus: matched[1]?.trim() ?? "" };
}

export function parseImproveComponentCommand(rawBody: string): {
  matched: boolean;
  component: string;
} {
  const body = rawBody.trim();
  const matched = body.match(IMPROVE_COMPONENT_COMMAND_RE);
  if (!matched) {
    return { matched: false, component: "" };
  }
  const component = matched[1]?.trim() ?? "";
  if (!component) {
    return { matched: false, component: "" };
  }
  return { matched: true, component };
}

export function parseGenerateLabelsCommand(rawBody: string): { matched: boolean } {
  return { matched: GENERATE_LABELS_COMMAND_RE.test(rawBody.trim()) };
}

export function parseSimilarCodeCommand(rawBody: string): {
  matched: boolean;
  query: string;
} {
  const body = rawBody.trim();
  const matched = body.match(SIMILAR_CODE_COMMAND_RE);
  if (!matched) {
    return { matched: false, query: "" };
  }
  return { matched: true, query: matched[1]?.trim() ?? "" };
}

export function parseAutoApproveCommand(rawBody: string): { matched: boolean } {
  return { matched: AUTO_APPROVE_COMMAND_RE.test(rawBody.trim()) };
}
