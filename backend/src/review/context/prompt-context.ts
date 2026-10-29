import { isProcessTemplateFile } from "../policy/policy.js";
import type { PullRequestReviewInput } from "../contracts.js";

function buildPromptHeaderAndDescription(
  pullRequest: PullRequestReviewInput,
): string[] {
  return [
    `Platform: ${pullRequest.platform}`,
    `Repository: ${pullRequest.repository}`,
    `Number: #${pullRequest.number}`,
    `Title: ${pullRequest.title}`,
    `Author: ${pullRequest.author}`,
    `Base -> Head: ${pullRequest.baseBranch} -> ${pullRequest.headBranch}`,
    `Additions: ${pullRequest.additions}, Deletions: ${pullRequest.deletions}, Changed files: ${pullRequest.changedFilesCount}`,
    "",
    "Description:",
    pullRequest.body || "(empty)",
    "",
  ];
}

function formatDiffFilesForPrompt(
  files: PullRequestReviewInput["changedFiles"],
  maxFiles: number | undefined,
): string {
  const selectedFiles = maxFiles ? files.slice(0, maxFiles) : files;
  return selectedFiles
    .map((file, index) => {
      return [
        `### File ${index + 1}`,
        `new_path=${file.newPath}`,
        `old_path=${file.oldPath}`,
        `status=${file.status}, additions=${file.additions}, deletions=${file.deletions}`,
        "```diff",
        file.extendedDiff,
        "```",
      ].join("\n");
    })
    .join("\n\n");
}

function formatGuidelinesForPrompt(
  processGuidelines: PullRequestReviewInput["processGuidelines"],
): string {
  if (!processGuidelines || processGuidelines.length === 0) {
    return "(none)";
  }

  return processGuidelines
    .map((item, index) => {
      return [
        `### Guideline ${index + 1}`,
        `path=${item.path}`,
        "```text",
        item.content.slice(0, 2_000),
        "```",
      ].join("\n");
    })
    .join("\n\n");
}

function formatStringListForPrompt(items: string[] | undefined): string {
  if (!items || items.length === 0) {
    return "(none)";
  }
  return items.map((item) => `- ${item}`).join("\n");
}

function formatCiChecksForPrompt(
  ciChecks: PullRequestReviewInput["ciChecks"],
): string {
  if (!ciChecks || ciChecks.length === 0) {
    return "(none)";
  }

  return ciChecks
    .slice(0, 30)
    .map((item) => {
      const url = item.detailsUrl ? `, url=${item.detailsUrl}` : "";
      const summary = item.summary ? `\n  summary=${item.summary}` : "";
      return `- ${item.name} (status=${item.status}, conclusion=${item.conclusion}${url})${summary}`;
    })
    .join("\n");
}

function formatProcessFilesForPrompt(pullRequest: PullRequestReviewInput): string {
  const processFiles = pullRequest.changedFiles.filter(
    (file) =>
      isProcessTemplateFile(file.newPath, pullRequest.platform) ||
      isProcessTemplateFile(file.oldPath, pullRequest.platform),
  );
  if (processFiles.length === 0) {
    return "(none)";
  }

  return processFiles
    .map((file) => `- ${file.newPath} (status=${file.status})`)
    .join("\n");
}

export function buildPromptSharedSections(params: {
  pullRequest: PullRequestReviewInput;
  maxDiffFiles?: number;
  includeProcessFiles: boolean;
}): string[] {
  const { pullRequest, maxDiffFiles, includeProcessFiles } = params;
  const sections: string[] = [...buildPromptHeaderAndDescription(pullRequest)];

  if (includeProcessFiles) {
    const processFilesText = formatProcessFilesForPrompt(pullRequest);
    sections.push("Process/template files in this change:");
    sections.push(processFilesText);
    sections.push("");
  }

  const guidelinesText = formatGuidelinesForPrompt(pullRequest.processGuidelines);
  const customRulesText = formatStringListForPrompt(pullRequest.customRules);
  const feedbackSignalsText = formatStringListForPrompt(
    pullRequest.feedbackSignals,
  );
  const ciChecksText = formatCiChecksForPrompt(pullRequest.ciChecks);
  const filesText = formatDiffFilesForPrompt(pullRequest.changedFiles, maxDiffFiles);

  sections.push("Repository process guidelines (.github templates/workflows/etc):");
  sections.push(guidelinesText);
  sections.push("");
  sections.push("Team custom review rules:");
  sections.push(customRulesText);
  sections.push("");
  sections.push("Feedback signals from developers:");
  sections.push(feedbackSignalsText);
  sections.push("");
  sections.push("CI checks on current head:");
  sections.push(ciChecksText);
  sections.push("");
  sections.push("Diff with line mapping:");
  sections.push(filesText || "(no textual patch available)");
  sections.push("");
  return sections;
}
