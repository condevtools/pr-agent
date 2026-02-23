export function mergeChangelogContent(
  currentContent: string,
  draft: string,
  title: string,
): string {
  const normalizedDraft = draft.trim();
  const safeTitle = title.trim();
  const body = currentContent.trim();
  if (body && hasChangelogTitle(body, safeTitle)) {
    return `${body.trimEnd()}\n`;
  }

  const entry = [`### ${safeTitle}`, "", normalizedDraft].join("\n");

  if (!body) {
    return ["# Changelog", "", "## Unreleased", "", entry, ""].join("\n");
  }

  const unreleasedRe = /^##\s+Unreleased\s*$/im;
  const match = unreleasedRe.exec(body);
  if (!match || match.index === undefined) {
    return [body, "", "## Unreleased", "", entry, ""].join("\n");
  }

  const insertAt = match.index + match[0].length;
  return `${body.slice(0, insertAt)}\n\n${entry}\n${body.slice(insertAt)}`.trimEnd() + "\n";
}

function hasChangelogTitle(content: string, title: string): boolean {
  const safeTitle = title.trim();
  if (!safeTitle) {
    return false;
  }

  const lines = content.split(/\r?\n/g);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("###")) {
      continue;
    }
    const heading = line.slice(3).trim();
    if (heading === safeTitle) {
      return true;
    }
  }
  return false;
}
