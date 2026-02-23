import type { DiffFileContext, PullRequestReviewResult } from "#review";

export interface InferReviewLabelsParams {
  title: string;
  files: DiffFileContext[];
  reviewResult: PullRequestReviewResult;
  hasSecretFinding: boolean;
  maxLabels: number;
  highRiskLabel?: string;
  fallbackLabel?: string;
  docsFromTitle?: boolean;
  docsFromFiles?: "none" | "all-documentation" | "any-markdown";
  includeTestLabelFromFiles?: boolean;
  includeCiLabelFromFiles?: boolean;
}

export function inferReviewLabels(params: InferReviewLabelsParams): string[] {
  const labels = new Set<string>();
  const title = params.title.trim().toLowerCase();
  const paths = params.files.map((file) => file.newPath.toLowerCase());

  if (params.hasSecretFinding) {
    labels.add("security");
  }

  if (/\b(fix|bug|hotfix)\b/.test(title)) {
    labels.add("bugfix");
  }

  if (/\b(feat|feature)\b/.test(title)) {
    labels.add("feature");
  }

  if (/\brefactor\b/.test(title)) {
    labels.add("refactor");
  }

  if (params.docsFromTitle && /\b(doc|readme)\b/.test(title)) {
    labels.add("docs");
  }

  if (params.docsFromFiles === "all-documentation") {
    if (paths.length > 0 && paths.every((path) => isDocumentationFile(path))) {
      labels.add("docs");
    }
  } else if (params.docsFromFiles === "any-markdown") {
    if (paths.some((path) => path.endsWith(".md") || path.endsWith(".mdx"))) {
      labels.add("docs");
    }
  }

  if (params.includeTestLabelFromFiles) {
    if (paths.some((path) => isTestFile(path))) {
      labels.add("tests");
    }
  }

  if (params.includeCiLabelFromFiles) {
    if (paths.some((path) => path.includes("workflow") || path.includes("ci"))) {
      labels.add("ci");
    }
  }

  if (params.reviewResult.riskLevel === "high" && params.highRiskLabel) {
    labels.add(params.highRiskLabel);
  }

  if (labels.size === 0 && params.fallbackLabel) {
    labels.add(params.fallbackLabel);
  }

  return Array.from(labels).slice(0, Math.max(1, params.maxLabels));
}

function isDocumentationFile(path: string): boolean {
  return (
    path.endsWith(".md") ||
    path.endsWith(".mdx") ||
    path.includes("/docs/") ||
    path.startsWith("docs/")
  );
}

function isTestFile(path: string): boolean {
  return path.includes("/test") || path.endsWith(".spec.ts") || path.endsWith(".test.ts");
}
