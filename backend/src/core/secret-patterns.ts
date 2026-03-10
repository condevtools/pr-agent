import { logCore } from "./logger.js";

const MAX_CUSTOM_SECRET_PATTERNS = 20;
const MAX_CUSTOM_SECRET_PATTERN_LENGTH = 240;
const MAX_WILDCARDS_PER_PATTERN = 24;

export interface CustomSecretPatternMatcher {
  test(text: string): boolean;
  sample(text: string): string;
}

interface ParsedCustomPattern {
  pattern: string;
  ignoreCase: boolean;
}

export function compileCustomSecretPatterns(
  rawPatterns: string[],
): CustomSecretPatternMatcher[] {
  return rawPatterns
    .map((raw) => raw.trim())
    .filter(Boolean)
    .slice(0, MAX_CUSTOM_SECRET_PATTERNS)
    .flatMap((raw) => {
      const normalized = raw.slice(0, MAX_CUSTOM_SECRET_PATTERN_LENGTH);
      const parsed = parseCustomPattern(normalized);
      if (!parsed) {
        logCore("debug", "secret_patterns.custom_pattern_rejected", {
          reason: "parse_failed",
        });
        return [];
      }
      const matcher = buildWildcardMatcher(parsed);
      if (!matcher) {
        logCore("debug", "secret_patterns.custom_pattern_rejected", {
          reason: "matcher_build_failed",
        });
      }
      return matcher ? [matcher] : [];
    });
}

function parseCustomPattern(raw: string): ParsedCustomPattern | undefined {
  if (!raw) {
    return undefined;
  }

  // Backward-compatible syntax: /pattern/i (only supports i flag to avoid regex runtime risks).
  if (raw.startsWith("/") && raw.length >= 2) {
    const lastSlash = raw.lastIndexOf("/");
    if (lastSlash > 0) {
      const body = raw.slice(1, lastSlash);
      const flags = raw.slice(lastSlash + 1);
      if (!body || !isSupportedPatternFlags(flags)) {
        return undefined;
      }
      return {
        pattern: body,
        ignoreCase: flags.includes("i"),
      };
    }
  }

  return {
    pattern: raw,
    ignoreCase: false,
  };
}

function isSupportedPatternFlags(flags: string): boolean {
  if (!flags) {
    return true;
  }
  for (const flag of flags) {
    if (flag !== "i") {
      return false;
    }
  }
  return true;
}

function buildWildcardMatcher(
  params: ParsedCustomPattern,
): CustomSecretPatternMatcher | undefined {
  const normalizedPattern = params.pattern.trim();
  if (!normalizedPattern) {
    return undefined;
  }
  const wildcardCount = countWildcards(normalizedPattern);
  if (wildcardCount > MAX_WILDCARDS_PER_PATTERN) {
    logCore("debug", "secret_patterns.custom_pattern_rejected", {
      reason: "too_many_wildcards",
      wildcardCount,
    });
    return undefined;
  }

  const matcherPattern = params.ignoreCase
    ? normalizedPattern.toLowerCase()
    : normalizedPattern;

  return {
    test: (text) => {
      const candidate = params.ignoreCase ? text.toLowerCase() : text;
      return wildcardIncludes(candidate, matcherPattern);
    },
    sample: (text) => {
      const candidate = params.ignoreCase ? text.toLowerCase() : text;
      const index = findFirstLiteralSegmentIndex(candidate, matcherPattern);
      if (index < 0) {
        return matcherPattern.replace(/[?*]/g, "").slice(0, 32) || matcherPattern;
      }
      const literal = extractFirstLiteralSegment(matcherPattern);
      if (!literal) {
        return matcherPattern.replace(/[?*]/g, "").slice(0, 32) || matcherPattern;
      }
      return text.slice(index, index + literal.length);
    },
  };
}

function countWildcards(pattern: string): number {
  let count = 0;
  for (const char of pattern) {
    if (char === "*" || char === "?") {
      count += 1;
    }
  }
  return count;
}

function wildcardIncludes(text: string, pattern: string): boolean {
  if (!pattern) {
    return false;
  }
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return text.includes(pattern);
  }
  const wrappedPattern = `*${pattern}*`;
  return wildcardMatchFull(text, wrappedPattern);
}

function wildcardMatchFull(text: string, pattern: string): boolean {
  let textIndex = 0;
  let patternIndex = 0;
  let lastStarIndex = -1;
  let lastStarTextIndex = -1;

  while (textIndex < text.length) {
    const patternChar = pattern[patternIndex];
    const textChar = text[textIndex];

    if (
      typeof patternChar === "string" &&
      (patternChar === "?" || patternChar === textChar)
    ) {
      textIndex += 1;
      patternIndex += 1;
      continue;
    }

    if (patternChar === "*") {
      lastStarIndex = patternIndex;
      lastStarTextIndex = textIndex;
      patternIndex += 1;
      continue;
    }

    if (lastStarIndex >= 0) {
      patternIndex = lastStarIndex + 1;
      lastStarTextIndex += 1;
      textIndex = lastStarTextIndex;
      continue;
    }

    return false;
  }

  while (patternIndex < pattern.length && pattern[patternIndex] === "*") {
    patternIndex += 1;
  }

  return patternIndex >= pattern.length;
}

function extractFirstLiteralSegment(pattern: string): string {
  const parts = pattern
    .split(/[*?]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts[0] ?? "";
}

function findFirstLiteralSegmentIndex(text: string, pattern: string): number {
  const literal = extractFirstLiteralSegment(pattern);
  if (!literal) {
    return -1;
  }
  return text.indexOf(literal);
}
