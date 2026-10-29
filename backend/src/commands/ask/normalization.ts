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
