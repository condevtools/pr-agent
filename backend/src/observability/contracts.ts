export interface AgentPromptReference {
  name: string;
  version: number;
}

export function parseAgentPromptReference(value: unknown): AgentPromptReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.name !== "string" || !isSafePromptName(item.name)
      || !Number.isSafeInteger(item.version) || Number(item.version) < 1) return undefined;
  return { name: item.name, version: Number(item.version) };
}

function isSafePromptName(value: string): boolean {
  return value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value);
}
