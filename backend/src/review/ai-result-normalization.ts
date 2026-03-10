export function normalizeReviewResultForSchema(parsed: unknown): {
  summary: string;
  riskLevel: "low" | "medium" | "high";
  reviews: Array<{
    severity: "low" | "medium" | "high";
    newPath: string;
    oldPath: string;
    type: "old" | "new";
    startLine: number;
    endLine: number;
    issueHeader: string;
    issueContent: string;
    suggestion?: string;
  }>;
  positives: string[];
  actionItems: string[];
} {
  const root = asRecord(parsed) ?? {};
  const reviews = normalizeReviewIssues(root.reviews).slice(0, 30);
  const riskLevel =
    normalizeParsedRiskLevel(root.riskLevel) ?? inferRiskLevelFromReviews(reviews);
  const summary =
    readNonEmptyString(root.summary) ??
    (reviews.length > 0
      ? `Detected ${reviews.length} potential issue(s) in changed lines.`
      : "No significant issues detected in changed lines.");

  return {
    summary,
    riskLevel,
    reviews,
    positives: normalizeStringArray(root.positives).slice(0, 10),
    actionItems: normalizeStringArray(root.actionItems).slice(0, 10),
  };
}

export function normalizeAskResultForSchema(parsed: unknown): {
  answer: string;
} {
  if (typeof parsed === "string") {
    const direct = parsed.trim();
    if (direct) {
      const extracted = extractEmbeddedAnswerFromText(direct);
      if (extracted) {
        return { answer: extracted };
      }
      return { answer: direct };
    }
  }

  const root = asRecord(parsed) ?? {};
  const answer =
    readNonEmptyString(root.answer) ??
    readNonEmptyString(root.summary) ??
    "Model did not return a structured answer. Please try again.";

  return { answer };
}

function extractEmbeddedAnswerFromText(text: string): string | undefined {
  const answerFieldIndex = text.lastIndexOf("\"answer\"");
  if (answerFieldIndex < 0) {
    return undefined;
  }

  for (
    let objectStart = text.lastIndexOf("{", answerFieldIndex);
    objectStart >= 0;
    objectStart = text.lastIndexOf("{", objectStart - 1)
  ) {
    const candidate = extractJsonObjectFromText(text, objectStart);
    if (!candidate) {
      continue;
    }

    try {
      const parsed = JSON.parse(candidate) as unknown;
      const root = asRecord(parsed);
      const answer = readNonEmptyString(root?.answer);
      if (answer) {
        return answer;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function extractJsonObjectFromText(text: string, startIndex: number): string | undefined {
  if (text[startIndex] !== "{") {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (!char) {
      continue;
    }

    if (escaping) {
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return undefined;
}

export function buildReviewFallbackFromNonJsonText(text: string): {
  summary: string;
  riskLevel: "low";
  reviews: [];
  positives: [];
  actionItems: [string];
} {
  const normalized = text.replace(/\s+/g, " ").trim();
  const snippet = normalized.slice(0, 240);
  const summary = snippet
    ? `Model returned non-JSON output. Preview: ${snippet}`
    : "Model returned non-JSON output.";

  return {
    summary,
    riskLevel: "low",
    reviews: [],
    positives: [],
    actionItems: [
      "Model output was not structured JSON; consider using a model with stronger structured-output support.",
    ],
  };
}

function normalizeReviewIssues(value: unknown): Array<{
  severity: "low" | "medium" | "high";
  newPath: string;
  oldPath: string;
  type: "old" | "new";
  startLine: number;
  endLine: number;
  issueHeader: string;
  issueContent: string;
  suggestion?: string;
}> {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: Array<{
    severity: "low" | "medium" | "high";
    newPath: string;
    oldPath: string;
    type: "old" | "new";
    startLine: number;
    endLine: number;
    issueHeader: string;
    issueContent: string;
    suggestion?: string;
  }> = [];

  for (const item of value) {
    const normalized = normalizeReviewIssue(item);
    if (normalized) {
      result.push(normalized);
    }
  }

  return result;
}

function normalizeReviewIssue(value: unknown):
  | {
      severity: "low" | "medium" | "high";
      newPath: string;
      oldPath: string;
      type: "old" | "new";
      startLine: number;
      endLine: number;
      issueHeader: string;
      issueContent: string;
      suggestion?: string;
    }
  | undefined {
  const item = asRecord(value);
  if (!item) {
    return undefined;
  }

  const severity = normalizeSeverity(item.severity) ?? "medium";
  const newPath =
    readNonEmptyString(item.newPath) ??
    readNonEmptyString(item.oldPath) ??
    "unknown";
  const oldPath =
    readNonEmptyString(item.oldPath) ??
    readNonEmptyString(item.newPath) ??
    newPath;
  const type = item.type === "old" ? "old" : "new";
  const startLine = normalizePositiveInt(item.startLine) ?? 1;
  const endLine = normalizePositiveInt(item.endLine) ?? startLine;
  const issueHeader = readNonEmptyString(item.issueHeader) ?? "Potential issue";
  const issueContent =
    readNonEmptyString(item.issueContent) ??
    "Potential issue detected in this changed block.";
  const suggestion = readNonEmptyString(item.suggestion);

  return {
    severity,
    newPath,
    oldPath,
    type,
    startLine,
    endLine,
    issueHeader,
    issueContent,
    suggestion,
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function normalizeParsedRiskLevel(value: unknown): "low" | "medium" | "high" | undefined {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return undefined;
}

const normalizeSeverity = normalizeParsedRiskLevel;

function inferRiskLevelFromReviews(
  reviews: Array<{ severity: "low" | "medium" | "high" }>,
): "low" | "medium" | "high" {
  if (reviews.some((item) => item.severity === "high")) {
    return "high";
  }
  if (reviews.some((item) => item.severity === "medium")) {
    return "medium";
  }
  return "low";
}

function normalizePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const normalized = Math.floor(parsed);
  if (normalized <= 0) {
    return undefined;
  }
  return normalized;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
