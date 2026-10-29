import {
  parsePatchWithLineNumbers,
  prioritizePatchHunks,
  type DiffFileContext,
} from "#review";

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
  coverage: DiffContextCoverage;
}

export interface DiffContextCoverage {
  status: "complete" | "partial";
  reasonCodes: string[];
  sourceFiles: number;
  includedFiles: number;
  excludedFiles: number;
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
  /** Provider-level truncation cannot be inferred from the returned file array. */
  sourceTruncated?: boolean;
  sourceFileCount?: number;
}): BuildDiffFileContextsResult {
  const files: DiffFileContext[] = [];
  let totalPatchChars = 0;
  let totalAdditions = 0;
  let totalDeletions = 0;
  let excludedFiles = 0;
  const reasonCodes = new Set<string>();

  for (const candidate of params.candidates) {
    if (files.length >= params.maxFiles || totalPatchChars >= params.maxTotalPatchChars) {
      excludedFiles += params.candidates.length - files.length - excludedFiles;
      reasonCodes.add(files.length >= params.maxFiles ? "file_limit" : "total_patch_limit");
      break;
    }
    if (!params.shouldIncludeFile(candidate.newPath)) {
      excludedFiles += 1;
      reasonCodes.add("file_filtered");
      continue;
    }

    const rawPatch = candidate.patch ?? "(binary / patch omitted)";
    const trimmedPatch = prioritizePatchHunks(rawPatch, params.maxPatchCharsPerFile);
    if (trimmedPatch !== rawPatch) reasonCodes.add("file_patch_truncated");
    if (totalPatchChars + trimmedPatch.length > params.maxTotalPatchChars) {
      excludedFiles += params.candidates.length - files.length - excludedFiles;
      reasonCodes.add("total_patch_limit");
      break;
    }
    if (candidate.patch === undefined) reasonCodes.add("patch_unavailable");

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
    coverage: {
      status: params.sourceTruncated || reasonCodes.size > 0 ? "partial" : "complete",
      reasonCodes: [...new Set([
        ...(params.sourceTruncated ? ["provider_file_list_truncated"] : []),
        ...reasonCodes,
      ])].sort(),
      sourceFiles: Math.max(params.candidates.length, params.sourceFileCount ?? params.candidates.length),
      includedFiles: files.length,
      excludedFiles: Math.max(excludedFiles,
        Math.max(params.candidates.length, params.sourceFileCount ?? params.candidates.length) - files.length),
    },
  };
}
