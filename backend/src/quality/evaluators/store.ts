import {
  PgRunArtifactStore,
  RunArtifactCorruptError,
  RunArtifactUnavailableError,
} from "../../agent-runtime/artifacts/index.js";
import type { RuntimeDatabase } from "../../agent-runtime/postgres/database.js";
import {
  requireRunPermission,
  runNotFound,
  type RunPrincipal,
} from "../../agent-runtime/runs/control-contracts.js";
import { judgeResultSchema, judgeRunInputSchema, type JudgeResult } from "./contracts.js";

interface JudgeStepRow {
  input_json: Record<string, unknown>;
  output_json: Record<string, unknown> | null;
  output_hash: string;
  result_ref: string | null;
}

export async function readJudgeResult(
  db: RuntimeDatabase,
  principal: RunPrincipal,
  judgeRunId: string,
): Promise<JudgeResult> {
  requireRunPermission(principal, "runs:read");
  return db.transaction(principal.tenantId, async (client) => {
    const result = await client.query<JudgeStepRow>(
      `SELECT r.input_json,s.output_json,s.output_hash,s.result_ref
       FROM pr_agent_harness.agent_runs r
       JOIN pr_agent_harness.agent_steps s
         ON s.tenant_id=r.tenant_id AND s.run_id=r.id
       JOIN pr_agent_harness.integration_bindings b
         ON b.tenant_id=r.tenant_id AND b.id=r.integration_id AND b.active
       WHERE r.tenant_id=$1 AND r.integration_id=$2 AND r.id=$3
         AND r.run_type='eval.judge.v1' AND r.status='succeeded'
         AND s.step_key='quality.judge.result.v1' AND s.step_kind='model' AND s.status='succeeded'`,
      [principal.tenantId, principal.integrationId, judgeRunId],
    );
    const row = result.rows[0];
    if (!row) throw runNotFound();
    const input = judgeRunInputSchema.parse(row.input_json);
    let value: unknown;
    try {
      value = await new PgRunArtifactStore(db).readStepOutputValueInTransaction<unknown>(client, {
        tenantId: principal.tenantId,
        integrationId: principal.integrationId,
        runId: judgeRunId,
      }, { output: row.output_json, outputHash: row.output_hash, resultRef: row.result_ref });
    } catch (error) {
      if (error instanceof RunArtifactCorruptError || error instanceof RunArtifactUnavailableError) throw runNotFound();
      throw error;
    }
    const judged = judgeResultSchema.parse(value);
    if (judged.judgeRunId !== judgeRunId || judged.sourceRunId !== input.sourceRunId
        || judged.sourceArtifactHash !== input.expectedArtifactHash
        || judged.sourceHash !== input.sourceHash) {
      throw runNotFound();
    }
    return judged;
  });
}

export interface JudgeScore {
  stableKey: string;
  name: "judge_support" | "judge_evidence" | "judge_actionability";
  kind: "CATEGORICAL" | "NUMERIC";
  value: string | number;
  comment: string;
}

export function judgeScores(result: JudgeResult): JudgeScore[] {
  return result.judgments.flatMap((judgment) => [
    {
      stableKey: `${result.judgeRunId}:${judgment.findingId}:support`,
      name: "judge_support" as const,
      kind: "CATEGORICAL" as const,
      value: judgment.judgment,
      comment: judgment.reason,
    },
    {
      stableKey: `${result.judgeRunId}:${judgment.findingId}:evidence`,
      name: "judge_evidence" as const,
      kind: "NUMERIC" as const,
      value: judgment.evidenceScore,
      comment: judgment.reason,
    },
    {
      stableKey: `${result.judgeRunId}:${judgment.findingId}:actionability`,
      name: "judge_actionability" as const,
      kind: "NUMERIC" as const,
      value: judgment.actionabilityScore,
      comment: judgment.reason,
    },
  ]);
}
