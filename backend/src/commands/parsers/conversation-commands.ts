const ASK_COMMAND_RE = /^\/(?:ask|ai-review\s+ask)\s+([\s\S]+)$/i;
const HELP_COMMAND_RE = /^\/(?:help|ai-review\s+help)\s*$/i;
const CONFIG_COMMAND_RE = /^\/(?:config|ai-review\s+config)\s*$/i;
const CUSTOM_PROMPT_COMMAND_RE =
  /^\/(?:custom[_-]?prompt|ai-review\s+custom[_-]?prompt)\s+([\s\S]+)$/i;
const HELP_DOCS_COMMAND_RE =
  /^\/(?:help[_-]?docs|ai-review\s+help[_-]?docs)\s+([\s\S]+)$/i;

export function parseAskCommand(rawBody: string): {
  matched: boolean;
  question: string;
} {
  const body = rawBody.trim();
  const matched = body.match(ASK_COMMAND_RE);
  if (!matched) {
    return { matched: false, question: "" };
  }

  const question = matched[1]?.trim() ?? "";
  if (!question) {
    return { matched: false, question: "" };
  }

  return { matched: true, question };
}

export function parseMentionCommand(
  rawBody: string,
  botLogin: string | string[],
): { matched: boolean; question: string } {
  const loginAliases = normalizeMentionLogins(botLogin);
  if (loginAliases.length === 0) {
    return { matched: false, question: "" };
  }
  const body = rawBody.trim();

  // Match @botLogin (case-insensitive) followed by the question text
  for (const login of loginAliases) {
    const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^@${escaped}\\s+([\\s\\S]+)$`, "i");
    const matched = body.match(re);
    if (!matched) {
      continue;
    }
    const question = matched[1]?.trim() ?? "";
    if (!question) {
      return { matched: false, question: "" };
    }
    return { matched: true, question };
  }

  return { matched: false, question: "" };
}

function normalizeMentionLogins(raw: string | string[]): string[] {
  const seeds = Array.isArray(raw) ? raw : [raw];
  const normalized = new Set<string>();

  for (const value of seeds) {
    const login = value.trim();
    if (!login) {
      continue;
    }
    normalized.add(login);

    if (login.toLowerCase().endsWith("[bot]")) {
      const withoutSuffix = login.slice(0, -5).trim();
      if (withoutSuffix) {
        normalized.add(withoutSuffix);
      }
      continue;
    }

    normalized.add(`${login}[bot]`);
  }

  return [...normalized];
}

export function parseHelpCommand(rawBody: string): { matched: boolean } {
  return { matched: HELP_COMMAND_RE.test(rawBody.trim()) };
}

export function parseConfigCommand(rawBody: string): { matched: boolean } {
  return { matched: CONFIG_COMMAND_RE.test(rawBody.trim()) };
}

export function parseCustomPromptCommand(rawBody: string): {
  matched: boolean;
  prompt: string;
} {
  const body = rawBody.trim();
  const matched = body.match(CUSTOM_PROMPT_COMMAND_RE);
  if (!matched) {
    return { matched: false, prompt: "" };
  }
  const prompt = matched[1]?.trim() ?? "";
  if (!prompt) {
    return { matched: false, prompt: "" };
  }
  return { matched: true, prompt };
}

export function parseHelpDocsCommand(rawBody: string): {
  matched: boolean;
  question: string;
} {
  const body = rawBody.trim();
  const matched = body.match(HELP_DOCS_COMMAND_RE);
  if (!matched) {
    return { matched: false, question: "" };
  }
  const question = matched[1]?.trim() ?? "";
  if (!question) {
    return { matched: false, question: "" };
  }
  return { matched: true, question };
}
