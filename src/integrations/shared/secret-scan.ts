import { compileCustomSecretPatterns, type CustomSecretPatternMatcher } from "#core";

export type SecretFinding = {
  path: string;
  line: number;
  kind: string;
  sample: string;
};

export interface SecretScanFile {
  patch: string;
  newPath: string;
}

export function findPotentialSecrets(params: {
  files: SecretScanFile[];
  customPatterns?: string[];
  maxFindings?: number;
}): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  const maxFindings = Math.max(1, params.maxFindings ?? 10);
  const compiledCustomPatterns = compileCustomSecretPatterns(params.customPatterns ?? []);

  for (const file of params.files) {
    for (const candidate of extractAddedLines(file.patch, file.newPath)) {
      const secret = detectSecretOnLine(candidate.text, compiledCustomPatterns);
      if (!secret) {
        continue;
      }
      if (isLikelyPlaceholder(candidate.text)) {
        continue;
      }

      const key = `${candidate.path}:${candidate.line}:${secret.kind}:${secret.sample}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      findings.push({
        path: candidate.path,
        line: candidate.line,
        kind: secret.kind,
        sample: secret.sample,
      });
      if (findings.length >= maxFindings) {
        return findings;
      }
    }
  }

  return findings;
}

export function isLikelyPlaceholder(text: string): boolean {
  const normalized = text.toLowerCase();
  const placeholderPatterns = [
    /\bchange[_-]?me\b/,
    /\byour[_-]?(api[_-]?key|token|secret|password)[_-]?here\b/,
    /\bfill[_-]?in[_-]?your(?:[_-]?(api[_-]?key|token|secret|password))?\b/,
    /<\s*your[-_a-z0-9]+\s*>/,
    /\bxxx+\b/,
    /\btodo\b/,
  ];
  if (placeholderPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  return (
    normalized.includes("example") ||
    normalized.includes("sample") ||
    normalized.includes("dummy") ||
    normalized.includes("placeholder") ||
    normalized.includes("replace-with")
  );
}

function extractAddedLines(
  patch: string,
  path: string,
): Array<{ path: string; line: number; text: string }> {
  const lines = patch.split("\n");
  const results: Array<{ path: string; line: number; text: string }> = [];
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = line.match(/\+(\d+)(?:,\d+)?/);
      newLine = match ? Number(match[1]) : newLine;
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      results.push({
        path,
        line: newLine,
        text: line.slice(1),
      });
      newLine += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }

    if (!line.startsWith("\\")) {
      newLine += 1;
    }
  }

  return results;
}

function detectSecretOnLine(
  text: string,
  customPatterns: CustomSecretPatternMatcher[] = [],
): { kind: string; sample: string } | undefined {
  const rules: Array<{ kind: string; pattern: RegExp }> = [
    { kind: "AWS Access Key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
    { kind: "GitHub Token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
    { kind: "GitLab Token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
    { kind: "Google API Key", pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
    { kind: "Google OAuth Token", pattern: /\bya29\.[0-9A-Za-z\-_]+\b/ },
    { kind: "Slack Token", pattern: /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,}\b/ },
    { kind: "Stripe Live Key", pattern: /\bsk_live_[0-9A-Za-z]{16,}\b/ },
    { kind: "NPM Token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
    { kind: "Twilio Secret Key", pattern: /\bSK[0-9a-fA-F]{32}\b/ },
    {
      kind: "Private Key",
      pattern: /-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP) PRIVATE KEY-----/,
    },
    {
      kind: "Azure Storage Connection String",
      pattern:
        /\bDefaultEndpointsProtocol=https;AccountName=[^;\s]+;AccountKey=[^;\s]+;EndpointSuffix=[^;\s]+\b/i,
    },
    {
      kind: "Database URL Credential",
      pattern:
        /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqps?):\/\/[^:\s/]+:[^@\s]+@[^\s]+/i,
    },
    {
      kind: "Generic Credential",
      pattern:
        /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][^"'\\n]{8,}["']/i,
    },
    {
      kind: "JWT-like Token",
      pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/,
    },
  ];

  for (const rule of rules) {
    const matched = text.match(rule.pattern);
    if (!matched) {
      continue;
    }

    return {
      kind: rule.kind,
      sample: redactSecretSample(matched[0]),
    };
  }

  for (const [index, matcher] of customPatterns.entries()) {
    if (!matcher.test(text)) {
      continue;
    }
    const sample = matcher.sample(text);
    return {
      kind: `Custom Secret Pattern #${index + 1}`,
      sample: redactSecretSample(sample || text.slice(0, 32)),
    };
  }

  return undefined;
}

function redactSecretSample(raw: string): string {
  const compact = raw.replace(/\s+/g, " ").trim();
  if (compact.length <= 10) {
    return `${compact.slice(0, 2)}***`;
  }

  return `${compact.slice(0, 4)}***${compact.slice(-4)}`;
}
