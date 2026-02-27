import { loadRuntimeStateValue, nowMs, saveRuntimeStateValue } from "@mr-agent/core";

export interface ProcessGuideline {
  path: string;
  content: string;
}

export async function loadProcessGuidelinesWithCache(params: {
  scope: string;
  cacheKey: string;
  ttlMs: number;
  maxEntries: number;
  filePaths: string[];
  directories: string[];
  maxGuidelines: number;
  maxGuidelinesPerDirectory: number;
  isTemplateFile: (path: string) => boolean;
  readFile: (path: string) => Promise<ProcessGuideline | undefined>;
  listDirectory: (path: string) => Promise<Array<{ path: string; type: string }>>;
}): Promise<ProcessGuideline[]> {
  const now = nowMs();
  const cached = loadRuntimeStateValue<ProcessGuideline[]>(
    params.scope,
    params.cacheKey,
    now,
  );
  if (cached) {
    return cached;
  }

  const guidelines: ProcessGuideline[] = [];
  const visited = new Set<string>();

  for (const path of params.filePaths) {
    await tryAddGuideline({
      path,
      readFile: params.readFile,
      guidelines,
      visited,
      maxGuidelines: params.maxGuidelines,
    });
    if (guidelines.length >= params.maxGuidelines) {
      break;
    }
  }

  for (const directory of params.directories) {
    if (guidelines.length >= params.maxGuidelines) {
      break;
    }
    const entries = await params.listDirectory(directory);
    for (const entry of entries.slice(0, params.maxGuidelinesPerDirectory)) {
      if (!params.isTemplateFile(entry.path)) {
        continue;
      }
      await tryAddGuideline({
        path: entry.path,
        readFile: params.readFile,
        guidelines,
        visited,
        maxGuidelines: params.maxGuidelines,
      });
      if (guidelines.length >= params.maxGuidelines) {
        break;
      }
    }
  }

  const result = guidelines.slice(0, params.maxGuidelines);
  saveRuntimeStateValue({
    scope: params.scope,
    key: params.cacheKey,
    value: result,
    expiresAt: now + Math.max(1, params.ttlMs),
    maxEntries: params.maxEntries,
  });

  return result;
}

async function tryAddGuideline(params: {
  path: string;
  readFile: (path: string) => Promise<ProcessGuideline | undefined>;
  guidelines: ProcessGuideline[];
  visited: Set<string>;
  maxGuidelines: number;
}): Promise<void> {
  if (params.guidelines.length >= params.maxGuidelines) {
    return;
  }
  const normalizedPath = params.path.trim();
  if (!normalizedPath) {
    return;
  }
  const dedupeKey = normalizedPath.toLowerCase();
  if (params.visited.has(dedupeKey)) {
    return;
  }
  params.visited.add(dedupeKey);

  const loaded = await params.readFile(normalizedPath);
  if (!loaded) {
    return;
  }
  const content = loaded.content.trim();
  if (!content) {
    return;
  }

  params.guidelines.push({
    path: loaded.path.trim() || normalizedPath,
    content: content.slice(0, 4_000),
  });
}
