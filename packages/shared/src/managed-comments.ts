import { fnv1a32Hex } from "@mr-agent/core";

export type ManagedCommentKey = string;

export const MANAGED_COMMENT_SCAN_PER_PAGE = 100;
export const MAX_MANAGED_COMMENT_SCAN_PAGES = 20;

export function normalizeManagedCommentKey(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
  return normalized || "default";
}

export function buildManagedCommandCommentKey(
  command: string,
  seed: string,
): string {
  const commandKey = normalizeManagedCommentKey(`cmd-${command}`).replace(
    /:/g,
    "-",
  );
  const normalizedSeed = seed.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 240);
  return `${commandKey}:${fnv1a32Hex(normalizedSeed)}`;
}

export function buildManagedCommentMarker(key: ManagedCommentKey): string {
  return `<!-- mr-agent:${normalizeManagedCommentKey(key)} -->`;
}

export function buildManagedCommentBody(
  body: string,
  key: ManagedCommentKey,
): string {
  return `${body.trim()}\n\n${buildManagedCommentMarker(key)}`;
}
