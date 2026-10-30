import type { DeepReviewArtifact, DeepReviewSource, DeepWorkflowPolicy } from "./contracts.js";
import { createDeepWorkflowPolicy } from "./policy.js";
import { deepReviewWorkflow } from "./workflow.js";
import { createStructuredModel } from "../../model/structured-model.js";
import type { DiffFileContext } from "../../repository/contracts.js";
import type { PullRequestReviewInput } from "../contracts.js";
import { RepositoryReadToolRegistry } from "./tools/registry.js";
import { type RepositoryReadAdapter } from "../../repository/contracts.js";
import { DeepReviewStore } from "./persistence/store.js";
import { deepBudgetSchema } from "./budget.js";
import type { RunLease } from "../../agent-runtime/runs/contracts.js";
import { currentRunExecutionContext, DeepReviewAnalysisFailedError, type RunExecutionContext } from "../../agent-runtime/execution/run-context.js";
import { getAgentRuntimeServices } from "../../agent-runtime/runtime/services.js";

export function frozenDeepWorkflowPolicy(lease: Pick<RunLease, "runtimeConfig">): DeepWorkflowPolicy {
  const budgets = deepBudgetSchema.parse(lease.runtimeConfig.deepBudget);
  const role = (name: "security" | "correctness") => ({
    maxTurns: 3, maxToolCalls: 2, maxCandidates: 20, maxWallTimeMs: 90_000,
    maxInputBytesPerTurn: Math.max(1, Math.min(96_000, budgets[name].inputTokens)),
    maxOutputTokensPerTurn: Math.max(1, Math.min(4_096, Math.floor(budgets[name].outputTokens / 3))),
  });
  return createDeepWorkflowPolicy({ roleLimits: { security: role("security"), correctness: role("correctness") },
    criticInputCandidateLimit: 40, criticLimits: { maxWallTimeMs: 60_000,
      maxInputBytes: Math.max(1, Math.min(128_000, budgets.critic.inputTokens)),
      maxOutputTokens: Math.max(1, Math.min(4_096, budgets.critic.outputTokens)) } });
}

/** This entry point has only read tools and never calls the publication coordinator. */
export async function executeDeepReviewRun(
  collected: { input: PullRequestReviewInput; files: DiffFileContext[]; coverage?: DeepReviewSource["coverage"] },
  adapter: RepositoryReadAdapter,
): Promise<void> {
  const context = currentRunExecutionContext();
  if (!context || context.lease.input.workflow !== "review.deep.v1") throw new Error("Deep review requires its durable Run context");
  const artifact = await executeDeepReviewWithContext(collected, adapter, context);
  if (artifact.analysisStatus === "failed") throw new DeepReviewAnalysisFailedError();
}

/** Production and fixture replay share source construction, model, tools, critic and gate. */
export async function executeDeepReviewWithContext(
  collected: { input: PullRequestReviewInput; files: DiffFileContext[]; coverage?: DeepReviewSource["coverage"] },
  adapter: RepositoryReadAdapter,
  context: RunExecutionContext,
): Promise<DeepReviewArtifact> {
  if (!["review.deep.v1", "eval.replay.v1"].includes(String(context.lease.input.workflow))) {
    throw new Error("Deep executor requires a review or evaluation Run");
  }
  const { lease } = context;
  const identity = { tenantId: lease.tenantId, integrationId: lease.integrationId, runId: lease.runId,
    platform: collected.input.platform, repository: collected.input.repository, baseSha: lease.baseSha, headSha: lease.headSha };
  const source: DeepReviewSource = { identity, input: collected.input,
    files: collected.files.map((file) => ({ path: file.newPath, oldPath: file.oldPath,
      status: file.status, changedLines: addedLineNumbers(file.patch) })),
    coverage: collected.coverage ?? { status: "partial", reasonCodes: ["collection_coverage_unknown"] } };
  const store = new DeepReviewStore((await getAgentRuntimeServices()).db);
  return deepReviewWorkflow.execute(source, { lease, step: context.step, signal: context.signal,
    model: createStructuredModel(), store,
    tools: new RepositoryReadToolRegistry({ identity, changedPaths: collected.files.map((file) => file.newPath), adapter }),
  }, frozenDeepWorkflowPolicy(lease));
}

/** Context lines are not changed lines; only '+' lines within a parsed hunk qualify. */
export function addedLineNumbers(patch: string): number[] {
  const result: number[] = [];
  let line: number | undefined;
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (line === undefined) continue;
    if (text.startsWith("+")) { result.push(line); line += 1; }
    else if (text.startsWith(" ")) line += 1;
    else if (!text.startsWith("-") && !text.startsWith("\\")) line = undefined;
  }
  return result;
}
