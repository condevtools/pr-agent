export interface RepositoryReadIdentity {
  tenantId: string;
  integrationId: string;
  runId: string;
  platform: "github" | "gitlab";
  repository: string;
  baseSha: string;
  headSha: string;
}

export interface RepositoryReadFile {
  path: string;
  bytes: Uint8Array;
  mode?: string;
}

export interface RepositoryReadAdapter {
  readFile(path: string, signal?: AbortSignal): Promise<RepositoryReadFile | undefined>;
  readCiStatus(signal?: AbortSignal): Promise<unknown>;
}

export type DiffSide = "old" | "new";

export interface DiffFileSummary {
  newPath: string;
  oldPath: string;
  status: string;
  additions: number;
  deletions: number;
  extendedDiff: string;
}

export interface DiffFileContext extends DiffFileSummary {
  patch: string;
  oldLinesWithNumber: Map<number, string>;
  newLinesWithNumber: Map<number, string>;
}
