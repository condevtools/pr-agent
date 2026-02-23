export function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

export function parseYamlBooleanMaybe(value: string): boolean | undefined {
  const normalized = stripYamlQuotes(value).trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "off", "0"].includes(normalized)) {
    return false;
  }
  return undefined;
}

export function parseYamlBoolean(value: string): boolean {
  return parseYamlBooleanMaybe(value) ?? false;
}
