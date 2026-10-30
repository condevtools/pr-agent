import { parseBooleanEnv, readOptionalStringEnv } from "../config/env.js";

type CoreLogLevel = "debug" | "info" | "warn" | "error";
const REDACTED = "[REDACTED]";
const SECRET_KEY = /(?:authorization|cookie|password|passwd|secret|token|private[_-]?key|api[_-]?key|credential|body|payload|error|message|untrusted)/iu;
const SAFE_ERROR_CLASSES = new Set([
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError",
  "AggregateError", "AbortError",
  "BadWebhookRequestError", "CommandAuthorizationError", "DeepReviewAnalysisFailedError",
  "DeepReviewEvidenceError", "EvolutionProposalFailedError", "EvolutionReleaseGateError",
  "FixPatchValidationError", "FixProposalFailedError", "FixStoreError", "GitHubRestApiError",
  "InactiveIntegrationBindingError", "ModelBudgetExceededError", "ModelCallConflictError",
  "ModelExecutionContextRequiredError", "PendingPublicationError", "ProviderHttpError",
  "PublicationBatchNotFoundError", "PublicationBatchPayloadUnavailableError",
  "PublicationBatchScopeConflictError", "PublicationBatchSourceConflictError",
  "PublicationBindingBlockedError", "PublicationBindingNotFoundError",
  "PublicationControlAuthorityError", "PublicationControlCommandConflictError",
  "PublicationControlEvidenceError", "PublicationControlOperationNotFoundError",
  "PublicationControlRecoveryClaimError", "PublicationControlStateError",
  "PublicationControlVersionConflictError", "PublicationDefiniteFailureError",
  "PublicationDispatchInProgressError", "PublicationIdentityConflictError",
  "PublicationLookupIndeterminateError", "PublicationOperationNotFoundError",
  "PublicationOperationVersionConflictError", "PublicationPreflightError",
  "PublicationSlotConflictError", "PublicationWriteBoundaryError", "ReplayAdmissionManifestDriftError",
  "RepositoryFileUnavailableError", "ReviewRunRevisionChangedError", "RunArtifactCorruptError",
  "RunArtifactLimitError", "RunArtifactUnavailableError", "RunCheckpointCompatibilityError",
  "RunControlError", "RunCreateConflictError", "RunExecutionContractError", "RunLeaseLostError",
  "RunOutputLimitError", "RunStepAttemptLimitError", "RunStepConflictError", "StalePublicationError",
  "VerificationJobLeaseLostError", "VerificationSnapshotUnavailableError", "VerifierSandboxTimeoutError",
  "VerifierWorkerStoppingError", "VerifiedWebhookHandlingError", "WebhookAuthError",
]);

export function logCore(
  level: CoreLogLevel,
  event: string,
  metadata?: Record<string, unknown>,
): void {
  if (level === "debug" && !shouldLogCoreEvents()) return;
  const record = { ...sanitizeRecord(metadata ?? {}, 0), timestamp: new Date().toISOString(),
    level, component: "core", event: bounded(event, 160) };
  const message = JSON.stringify(record);
  if (level === "error") { console.error(message); return; }
  if (level === "warn") { console.warn(message); return; }
  console.info(message);
}

export function sanitizeLogMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return sanitizeRecord(metadata, 0);
}

function sanitizeRecord(record: Record<string, unknown>, depth: number): Record<string, unknown> {
  const entries: Array<[string, unknown]> = Object.entries(record).slice(0, 50).map(([key, value]) => {
    const sanitized = value instanceof Error ? sanitizeValue(value, depth + 1, key)
      : SECRET_KEY.test(key) ? REDACTED : sanitizeValue(value, depth + 1, key);
    return [bounded(key, 100), sanitized];
  });
  if (Object.keys(record).length > entries.length) entries.push(["truncated", true]);
  return Object.fromEntries(entries);
}

function sanitizeValue(value: unknown, depth: number, key = ""): unknown {
  if (depth > 4) return "[MAX_DEPTH]";
  if (value instanceof Error) {
    const candidateCode = (value as Error & { code?: unknown }).code;
    const code = typeof candidateCode === "string" && /^[0-9A-Z]{5}$/u.test(candidateCode)
      ? candidateCode : undefined;
    return { causeClass: value.cause instanceof Error ? safeErrorClass(value.cause.name) : undefined,
      domainCode: code, errorType: safeErrorClass(value.name) ?? "Error" };
  }
  if (typeof value === "string") {
    if (/(?:url|uri|path|origin|endpoint)$/iu.test(key)) return safeLocation(value);
    return bounded(value, 1_024);
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean" || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === "object") return sanitizeRecord(value as Record<string, unknown>, depth);
  return bounded(String(value), 200);
}

function safeErrorClass(value: string): string | undefined {
  return SAFE_ERROR_CLASSES.has(value) ? value : undefined;
}

function safeLocation(raw: string): string {
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:/iu.test(raw);
    const url = new URL(raw, "http://redacted.invalid");
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return bounded(absolute ? url.origin : url.pathname, 1_024);
  } catch { return "[INVALID_LOCATION]"; }
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}

function shouldLogCoreEvents(
  rawValue: string | undefined = readOptionalStringEnv("PR_AGENT_CORE_LOGS"),
): boolean {
  return parseBooleanEnv(rawValue);
}
