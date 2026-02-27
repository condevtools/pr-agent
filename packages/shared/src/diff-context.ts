import {
  parsePatchWithLineNumbers,
  prioritizePatchHunks,
  type DiffFileContext,
} from "@mr-agent/review";

export interface DiffContextCandidate {
  newPath: string;
  oldPath?: string;
  status: string;
  patch?: string;
  additions?: number;
  deletions?: number;
}

export interface BuildDiffFileContextsResult {
  files: DiffFileContext[];
  totalPatchChars: number;
  totalAdditions: number;
  totalDeletions: number;
}

export function buildDiffFileContexts(params: {
  candidates: DiffContextCandidate[];
  maxFiles: number;
  maxPatchCharsPerFile: number;
  maxTotalPatchChars: number;
  shouldIncludeFile: (newPath: string) => boolean;
  resolveStats?: (
    trimmedPatch: string,
    candidate: DiffContextCandidate,
  ) => { additions: number; deletions: number };
}): BuildDiffFileContextsResult {
  const files: DiffFileContext[] = [];
  let totalPatchChars = 0;
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const candidate of params.candidates) {
    if (files.length >= params.maxFiles || totalPatchChars >= params.maxTotalPatchChars) {
      break;
    }
    if (!params.shouldIncludeFile(candidate.newPath)) {
      continue;
    }

    const rawPatch = candidate.patch ?? "(binary / patch omitted)";
    const trimmedPatch = prioritizePatchHunks(rawPatch, params.maxPatchCharsPerFile);
    if (totalPatchChars + trimmedPatch.length > params.maxTotalPatchChars) {
      break;
    }

    const parsedPatch = parsePatchWithLineNumbers(trimmedPatch);
    totalPatchChars += trimmedPatch.length;
    const stats = params.resolveStats
      ? params.resolveStats(trimmedPatch, candidate)
      : {
          additions: Math.max(0, candidate.additions ?? 0),
          deletions: Math.max(0, candidate.deletions ?? 0),
        };
    totalAdditions += Math.max(0, stats.additions);
    totalDeletions += Math.max(0, stats.deletions);

    files.push({
      newPath: candidate.newPath,
      oldPath: candidate.oldPath ?? candidate.newPath,
      status: candidate.status,
      additions: Math.max(0, stats.additions),
      deletions: Math.max(0, stats.deletions),
      patch: trimmedPatch,
      extendedDiff: parsedPatch.extendedDiff,
      oldLinesWithNumber: parsedPatch.oldLinesWithNumber,
      newLinesWithNumber: parsedPatch.newLinesWithNumber,
    });
  }

  return {
    files,
    totalPatchChars,
    totalAdditions,
    totalDeletions,
  };
}
