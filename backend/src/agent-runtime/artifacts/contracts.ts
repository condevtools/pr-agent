export const RUN_ARTIFACT_LIMITS = Object.freeze({
  maxRawBytes: 32 * 1024 * 1024,
  maxCompressedBytes: 8 * 1024 * 1024,
  maxRunRawBytes: 128 * 1024 * 1024,
  retentionDays: 30,
});

export type RunArtifactPurpose = "step_output" | "fix_snapshot" | "evaluation" | "log" | "other";
export type RunArtifactHoldKind = "fix" | "evolution" | "qualification" | "legal" | "other";

export interface RunArtifactScope {
  tenantId: string;
  integrationId: string;
  runId: string;
}

export interface RunArtifactRef extends RunArtifactScope {
  artifactHash: string;
  rawSizeBytes: number;
  compressedSizeBytes: number;
  contentType: string;
  purpose: RunArtifactPurpose;
  retentionExpiresAt: string;
}

export interface PreparedRunArtifact {
  artifactHash: string;
  rawSizeBytes: number;
  compressedSizeBytes: number;
  contentType: string;
  purpose: RunArtifactPurpose;
  compressed: Buffer;
}

export type RunArtifactRead = { status: "available"; ref: RunArtifactRef; content: Buffer }
  | { status: "gone"; ref: RunArtifactRef; purgedAt: string };

export class RunArtifactLimitError extends Error {
  constructor(readonly code: "artifact_raw_limit" | "artifact_compressed_limit" | "run_artifact_quota") {
    super(code); this.name = "RunArtifactLimitError";
  }
}

export class RunArtifactCorruptError extends Error {
  constructor(readonly artifactHash: string) {
    super(`Run artifact content failed integrity verification: ${artifactHash}`);
    this.name = "RunArtifactCorruptError";
  }
}

export class RunArtifactUnavailableError extends Error {
  constructor(readonly artifactHash: string, readonly reason: "gone" | "missing") {
    super(`Run artifact is ${reason}: ${artifactHash}`);
    this.name = "RunArtifactUnavailableError";
  }
}
