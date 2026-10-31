import { observeAgentOperation } from "../../observability/index.js";
import { RunCheckpointCompatibilityError, type RunCheckpoint, type RunLeaseIdentity } from "../runs/contracts.js";

type CheckpointAction = "save" | "reuse" | "validate";
type CheckpointSuccess = "saved" | "reused" | "validated";

interface CheckpointObservationScope extends RunLeaseIdentity {
  integrationId: string;
  checkpointKind?: "step_completed" | "publication_frozen";
  stepId?: string;
  stepAttemptId?: string;
  outputHash?: string;
  artifactHash?: string;
  publicationBatchId?: string;
}

/**
 * The callback only stages metadata in memory. Success is emitted after action
 * resolves, so callers must await the entire database transaction, including COMMIT.
 * This is best-effort telemetry, never a recovery source or a durable audit log.
 */
export function observeCheckpoint<T>(
  operation: CheckpointAction,
  scope: CheckpointObservationScope,
  action: (record: (checkpoint: RunCheckpoint, outcome: CheckpointSuccess) => void) => Promise<T>,
): Promise<T> {
  return observeAgentOperation(`${operation}-checkpoint`, "span", {
    metadata: {
      tenantId: scope.tenantId,
      integrationId: scope.integrationId,
      runId: scope.runId,
      leaseEpoch: scope.epoch,
      checkpointAction: operation,
      checkpointKind: scope.checkpointKind,
      stepId: scope.stepId,
      stepAttemptId: scope.stepAttemptId,
      outputHash: scope.outputHash,
      artifactHash: scope.artifactHash,
      publicationBatchId: scope.publicationBatchId,
    },
  }, async (observation) => {
    let summary: Record<string, unknown> | undefined;
    let success: CheckpointSuccess | undefined;
    const record = (checkpoint: RunCheckpoint, outcome: CheckpointSuccess) => {
      // Explicit allowlist: never spread state_json, output, or artifact contents.
      summary = {
        checkpointId: checkpoint.id,
        checkpointSequence: checkpoint.sequence,
        checkpointKind: checkpoint.kind,
        checkpointSchemaVersion: checkpoint.schemaVersion,
        checkpointRuntimeVersionHash: checkpoint.runtimeVersionHash,
        checkpointStateHash: checkpoint.stateHash,
        checkpointCreatedAt: checkpoint.createdAt,
        stepId: checkpoint.stepId,
        stepAttemptId: checkpoint.stepAttemptId,
        publicationBatchId: checkpoint.publicationBatchId,
      };
      success = outcome;
    };
    try {
      const result = await action(record);
      observation.update({ metadata: { ...summary, checkpointOutcome: success ?? "missing" } });
      return result;
    } catch (error) {
      observation.update({
        metadata: { ...summary, checkpointOutcome: error instanceof RunCheckpointCompatibilityError
          ? "rejected" : "failed" },
        level: "ERROR",
      });
      throw error;
    }
  });
}
