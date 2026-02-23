export interface RuntimeStateEntry {
  value: unknown;
  expiresAt: number;
  updatedAt: number;
}

export interface RuntimeStateSnapshot {
  version: 1;
  scopes: Record<string, Record<string, RuntimeStateEntry>>;
}

export const DEFAULT_RUNTIME_STATE_VERSION = 1 as const;

export function createEmptyRuntimeStateSnapshot(): RuntimeStateSnapshot {
  return {
    version: DEFAULT_RUNTIME_STATE_VERSION,
    scopes: {},
  };
}

export function normalizeRuntimeStateSnapshot(input: unknown): RuntimeStateSnapshot {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return createEmptyRuntimeStateSnapshot();
  }
  const root = input as {
    version?: unknown;
    scopes?: unknown;
  };
  if (root.version !== DEFAULT_RUNTIME_STATE_VERSION) {
    return createEmptyRuntimeStateSnapshot();
  }

  const scopes: Record<string, Record<string, RuntimeStateEntry>> = {};
  if (!root.scopes || typeof root.scopes !== "object" || Array.isArray(root.scopes)) {
    return {
      version: DEFAULT_RUNTIME_STATE_VERSION,
      scopes,
    };
  }

  for (const [scopeName, rawScope] of Object.entries(root.scopes as Record<string, unknown>)) {
    if (!rawScope || typeof rawScope !== "object" || Array.isArray(rawScope)) {
      continue;
    }

    const scope: Record<string, RuntimeStateEntry> = {};
    for (const [key, rawEntry] of Object.entries(rawScope as Record<string, unknown>)) {
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        continue;
      }
      const entry = rawEntry as {
        value?: unknown;
        expiresAt?: unknown;
        updatedAt?: unknown;
      };
      if (
        typeof entry.expiresAt !== "number" ||
        !Number.isFinite(entry.expiresAt) ||
        typeof entry.updatedAt !== "number" ||
        !Number.isFinite(entry.updatedAt)
      ) {
        continue;
      }
      scope[key] = {
        value: entry.value,
        expiresAt: entry.expiresAt,
        updatedAt: entry.updatedAt,
      };
    }

    if (Object.keys(scope).length > 0) {
      scopes[scopeName] = scope;
    }
  }

  return {
    version: DEFAULT_RUNTIME_STATE_VERSION,
    scopes,
  };
}

export function mergeRuntimeStateSnapshots(
  existing: RuntimeStateSnapshot,
  incoming: RuntimeStateSnapshot,
): RuntimeStateSnapshot {
  const scopes: Record<string, Record<string, RuntimeStateEntry>> = {};
  const allScopes = new Set<string>([
    ...Object.keys(existing.scopes),
    ...Object.keys(incoming.scopes),
  ]);

  for (const scope of allScopes) {
    const mergedScope: Record<string, RuntimeStateEntry> = {};
    const existingScope = existing.scopes[scope] ?? {};
    const incomingScope = incoming.scopes[scope] ?? {};
    const allKeys = new Set<string>([...Object.keys(existingScope), ...Object.keys(incomingScope)]);
    for (const key of allKeys) {
      const existingEntry = existingScope[key];
      const incomingEntry = incomingScope[key];
      if (!existingEntry && incomingEntry) {
        mergedScope[key] = incomingEntry;
        continue;
      }
      if (existingEntry && !incomingEntry) {
        mergedScope[key] = existingEntry;
        continue;
      }
      if (!existingEntry || !incomingEntry) {
        continue;
      }
      mergedScope[key] =
        incomingEntry.updatedAt >= existingEntry.updatedAt ? incomingEntry : existingEntry;
    }

    if (Object.keys(mergedScope).length > 0) {
      scopes[scope] = mergedScope;
    }
  }

  return {
    version: DEFAULT_RUNTIME_STATE_VERSION,
    scopes,
  };
}
