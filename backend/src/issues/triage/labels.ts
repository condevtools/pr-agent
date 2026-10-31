import type { SimilarIssueMatch } from "../similarity/scorer.js";

export const ISSUE_TRIAGE_LABEL_ALLOWLIST = [
  "bug", "enhancement", "documentation", "security", "performance", "testing",
  "has-similar-issue", "ai-triaged",
] as const;

export function inferIssueTriageLabels(input: {
  title: string;
  body: string;
  similar: readonly SimilarIssueMatch[];
}): string[] {
  const text = `${input.title}\n${input.body}`.toLowerCase();
  const labels: string[] = [];
  const add = (label: typeof ISSUE_TRIAGE_LABEL_ALLOWLIST[number], pattern: RegExp) => {
    if (pattern.test(text)) labels.push(label);
  };
  add("bug", /(bug|fix|error|exception|crash|fail|regression|报错|异常|崩溃|失败)/iu);
  add("enhancement", /(feature|enhancement|proposal|request|建议|需求|优化)/iu);
  add("documentation", /(docs?|readme|documentation|文档)/iu);
  add("security", /(security|xss|csrf|sql injection|token|secret|credential|漏洞|安全)/iu);
  add("performance", /(performance|latency|slow|memory leak|cpu|性能|卡顿)/iu);
  add("testing", /(test|flaky|spec|coverage|测试)/iu);
  if (input.similar.length > 0) labels.push("has-similar-issue");
  labels.push("ai-triaged");
  return [...new Set(labels)].slice(0, ISSUE_TRIAGE_LABEL_ALLOWLIST.length);
}

/** Returns repository-preserved spellings only when enumeration was proven complete. */
export function selectExistingIssueLabels(
  suggested: readonly string[],
  repositoryLabels: readonly string[],
  labelsComplete: boolean,
): string[] {
  if (!labelsComplete) return [];
  const allowed = new Set<string>(ISSUE_TRIAGE_LABEL_ALLOWLIST);
  const existing = new Map(repositoryLabels.map((name) => [name.toLocaleLowerCase("en-US"), name]));
  return [...new Set(suggested.map((name) => name.toLocaleLowerCase("en-US")))]
    .filter((name) => allowed.has(name))
    .map((name) => existing.get(name))
    .filter((name): name is string => Boolean(name));
}
