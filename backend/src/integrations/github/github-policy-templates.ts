import type { GitHubReviewContext } from "./github-review.js";
import {
  tryLoadRepositoryContent,
  tryLoadRepositoryTextFile,
} from "./github-policy-config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarkdownSection {
  heading: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Template path candidates
// ---------------------------------------------------------------------------

const ISSUE_TEMPLATE_PATH_CANDIDATES = [
  ".github/ISSUE_TEMPLATE/bug_report.md",
  ".github/ISSUE_TEMPLATE/feature_request.md",
  ".github/ISSUE_TEMPLATE.md",
];

const PULL_REQUEST_TEMPLATE_PATH_CANDIDATES = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
];

// ---------------------------------------------------------------------------
// Default templates
// ---------------------------------------------------------------------------

const DEFAULT_ISSUE_TEMPLATE_MARKDOWN = [
  "## Summary",
  "",
  "<!-- Describe the issue and impact -->",
  "",
  "## Steps to Reproduce",
  "",
  "<!-- 1) ... 2) ... 3) ... -->",
  "",
  "## Expected Behavior",
  "",
  "<!-- What should happen -->",
].join("\n");

const DEFAULT_PULL_REQUEST_TEMPLATE_MARKDOWN = [
  "## Summary",
  "",
  "<!-- What changed and why -->",
  "",
  "## Test Plan",
  "",
  "<!-- How you verified this change -->",
  "",
  "## Related Issue",
  "",
  "<!-- e.g. Closes #123 -->",
].join("\n");

const DEFAULT_ISSUE_TEMPLATE_SECTIONS = extractTemplateSectionHeadings(
  DEFAULT_ISSUE_TEMPLATE_MARKDOWN,
);
const DEFAULT_PULL_REQUEST_TEMPLATE_SECTIONS = extractTemplateSectionHeadings(
  DEFAULT_PULL_REQUEST_TEMPLATE_MARKDOWN,
);

// ---------------------------------------------------------------------------
// Template section loading
// ---------------------------------------------------------------------------

export async function loadIssueTemplateSections(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  ref?: string;
}): Promise<string[]> {
  const explicit = await loadFirstMatchedTemplate(
    params,
    ISSUE_TEMPLATE_PATH_CANDIDATES,
  );
  if (explicit) {
    return extractTemplateSectionHeadings(explicit);
  }

  const fromDirectory = await loadFirstMarkdownTemplateFromDirectory({
    ...params,
    directoryPath: ".github/ISSUE_TEMPLATE",
  });
  return fromDirectory
    ? extractTemplateSectionHeadings(fromDirectory)
    : DEFAULT_ISSUE_TEMPLATE_SECTIONS;
}

export async function loadPullRequestTemplateSections(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  ref?: string;
}): Promise<string[]> {
  const explicit = await loadFirstMatchedTemplate(
    params,
    PULL_REQUEST_TEMPLATE_PATH_CANDIDATES,
  );
  if (explicit) {
    return extractTemplateSectionHeadings(explicit);
  }

  const fromDirectory = await loadFirstMarkdownTemplateFromDirectory({
    ...params,
    directoryPath: ".github/PULL_REQUEST_TEMPLATE",
  });
  return fromDirectory
    ? extractTemplateSectionHeadings(fromDirectory)
    : DEFAULT_PULL_REQUEST_TEMPLATE_SECTIONS;
}

// ---------------------------------------------------------------------------
// Template file discovery
// ---------------------------------------------------------------------------

async function loadFirstMatchedTemplate(
  params: {
    context: GitHubReviewContext;
    owner: string;
    repo: string;
    ref?: string;
  },
  pathCandidates: string[],
): Promise<string | undefined> {
  for (const path of pathCandidates) {
    const content = await tryLoadRepositoryTextFile({
      ...params,
      path,
    });
    if (content) {
      return content;
    }
  }

  return undefined;
}

async function loadFirstMarkdownTemplateFromDirectory(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  ref?: string;
  directoryPath: string;
}): Promise<string | undefined> {
  const response = await tryLoadRepositoryContent({
    context: params.context,
    owner: params.owner,
    repo: params.repo,
    path: params.directoryPath,
    ref: params.ref,
  });
  if (!response || !Array.isArray(response)) {
    return undefined;
  }

  const markdownCandidate = response.find((item) => {
    const path = (item.path ?? "").toLowerCase();
    return path.endsWith(".md");
  });
  if (!markdownCandidate?.path) {
    return undefined;
  }

  return tryLoadRepositoryTextFile({
    context: params.context,
    owner: params.owner,
    repo: params.repo,
    path: markdownCandidate.path,
    ref: params.ref,
  });
}

// ---------------------------------------------------------------------------
// Markdown section parsing
// ---------------------------------------------------------------------------

export function findMissingSections(body: string, requiredSections: string[]): string[] {
  if (requiredSections.length === 0) {
    return [];
  }

  const sections = parseMarkdownSections(body);
  const normalizedSectionMap = sections.map((section) => ({
    ...section,
    normalizedHeading: normalizeToken(section.heading),
  }));

  const missing: string[] = [];
  for (const sectionName of requiredSections) {
    const normalizedTarget = normalizeToken(sectionName);
    if (!normalizedTarget) {
      continue;
    }

    const matched = normalizedSectionMap.find((section) => {
      if (!section.normalizedHeading) {
        return false;
      }

      return (
        section.normalizedHeading === normalizedTarget ||
        section.normalizedHeading.includes(normalizedTarget) ||
        normalizedTarget.includes(section.normalizedHeading)
      );
    });
    if (!matched || !hasMeaningfulContent(matched.content)) {
      missing.push(sectionName);
    }
  }

  return missing;
}

function parseMarkdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split("\n");
  const sections: MarkdownSection[] = [];

  let currentHeading = "";
  let currentContent: string[] = [];

  for (const line of lines) {
    const heading = parseMarkdownHeading(line);
    if (!heading) {
      if (currentHeading) {
        currentContent.push(line);
      }
      continue;
    }

    if (currentHeading) {
      sections.push({
        heading: currentHeading,
        content: currentContent.join("\n"),
      });
    }
    currentHeading = heading;
    currentContent = [];
  }

  if (currentHeading) {
    sections.push({
      heading: currentHeading,
      content: currentContent.join("\n"),
    });
  }

  return sections;
}

function parseMarkdownHeading(line: string): string | undefined {
  const match = line.match(/^#{2,6}\s+(.+?)\s*$/);
  return match?.[1]?.trim();
}

function hasMeaningfulContent(content: string): boolean {
  const normalized = content
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/[-*]\s+\[[ xX]\]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return false;
  }

  return normalized !== "_no response_" && normalized !== "no response";
}

export function extractTemplateSectionHeadings(template: string): string[] {
  const headings = template
    .split("\n")
    .map((line) => parseMarkdownHeading(line))
    .filter((heading): heading is string => Boolean(heading))
    .map((heading) => heading.trim())
    .filter((heading) => heading.length > 0)
    .slice(0, 12);

  return [...new Set(headings)];
}

function normalizeToken(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[`*_~>#:[\]()/\\\-.,，。!?！？]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
