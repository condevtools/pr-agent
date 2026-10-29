import { z } from "zod";

export const RUN_PERMISSIONS = ["runs:create", "runs:read", "runs:trace", "runs:cancel",
  "runs:resume", "runs:retry", "runs:recover", "runs:rerun", "fixes:create", "fixes:approve", "fixes:revoke",
  "feedback:create", "annotations:create", "annotations:arbitrate",
  "evaluations:create", "evaluations:read", "evaluations:holdout"] as const;
export type RunPermission = typeof RUN_PERMISSIONS[number];
export interface RunPrincipal {
  subjectId: string;
  actorType: "user" | "service";
  tenantId: string;
  integrationId: string;
  permissions: readonly RunPermission[];
}

const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const commandBase = { expectedVersion: version, commandKey: z.string().min(1).max(200) };
const publicationDecisionIdentity = {
  waitId: z.string().uuid(), waitVersion: version,
  intentHash: hash, operationVersion: version,
};
const publicationEvidence = z.object({ kind: z.literal("provider_confirmation"),
  reference: z.string().min(1).max(2048), actualRevision: z.string().min(1).max(128).optional() }).strict();
export const publicationDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ ...publicationDecisionIdentity, decision: z.literal("confirm_occurred"),
    evidence: publicationEvidence.extend({ actualRevision: z.string().min(1).max(128) }),
    remoteId: z.string().min(1).max(512) }).strict(),
  z.object({ ...publicationDecisionIdentity, decision: z.literal("confirm_not_occurred"), evidence: publicationEvidence }).strict(),
  z.object({ ...publicationDecisionIdentity, decision: z.literal("authorize_retry"), evidence: publicationEvidence }).strict(),
  z.object({ ...publicationDecisionIdentity, decision: z.literal("abandon_publication"), evidence: publicationEvidence }).strict(),
]);
export const runCommandSchema = z.discriminatedUnion("kind", [
  z.object({ ...commandBase, kind: z.literal("cancel") }).strict(),
  z.object({ ...commandBase, kind: z.literal("retry") }).strict(),
  z.object({ ...commandBase, kind: z.literal("recover") }).strict(),
  z.object({ ...commandBase, kind: z.literal("rerun") }).strict(),
  z.object({ ...commandBase, kind: z.literal("resume"), decision: publicationDecisionSchema }).strict(),
]);
export type RunCommand = z.infer<typeof runCommandSchema>;
export interface RunCommandReceipt {
  id: string;
  runId: string;
  commandKey: string;
  kind: RunCommand["kind"];
  status: "accepted" | "completed" | "rejected";
  result: Record<string, unknown>;
  createdAt: string;
}

export class RunControlError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = "RunControlError";
  }
}

export function requireRunPermission(principal: RunPrincipal, permission: RunPermission): void {
  if (!principal.permissions.includes(permission)) throw new RunControlError("FORBIDDEN", 403, "Run permission is required");
}

export function runNotFound(): RunControlError {
  return new RunControlError("RUN_NOT_FOUND", 404, "Run was not found");
}

export function runConflict(message: string): RunControlError {
  return new RunControlError("RUN_CONFLICT", 409, message);
}
