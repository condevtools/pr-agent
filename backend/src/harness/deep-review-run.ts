import type { DeepReviewSource, DeepWorkflowPolicy } from "../agents/contracts.js";
import { createDeepWorkflowPolicy } from "../agents/policy.js";
import { deepReviewWorkflow } from "../agents/deep-workflow.js";
import { createStructuredModel } from "../review/structured-model.js";
import type { DiffFileContext, PullRequestReviewInput } from "../review/review-types.js";
import { RepositoryReadToolRegistry, type RepositoryReadAdapter } from "../integrations/shared/repository-read-tools.js";
import { DeepReviewStore } from "./deep-review-store.js";
import { deepBudgetSchema } from "./deep-budget.js";
import type { RunLease } from "./run-contracts.js";
import { currentReviewRunContext, DeepReviewAnalysisFailedError } from "./review-run-context.js";
import { getHarnessServices } from "./runtime.js";

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
  const context = currentReviewRunContext();
  if (!context || context.lease.input.workflow !== "review.deep.v1") throw new Error("Deep review requires its durable Run context");
  const { lease } = context;
  const identity = { tenantId: lease.tenantId, integrationId: lease.integrationId, runId: lease.runId,
    platform: collected.input.platform, repository: collected.input.repository, baseSha: lease.baseSha, headSha: lease.headSha };
  const source: DeepReviewSource = { identity, input: collected.input,
    files: collected.files.map((file) => ({ path: file.newPath, oldPath: file.oldPath,
      status: file.status, changedLines: addedLineNumbers(file.patch) })),
    coverage: collected.coverage ?? { status: "partial", reasonCodes: ["collection_coverage_unknown"] } };
  const store = new DeepReviewStore((await getHarnessServices()).db);
  const artifact = await deepReviewWorkflow.execute(source, { lease, step: context.step, signal: context.signal,
    model: createStructuredModel(), store,
    tools: new RepositoryReadToolRegistry({ identity, changedPaths: collected.files.map((file) => file.newPath), adapter }),
  }, frozenDeepWorkflowPolicy(lease));
  if (artifact.analysisStatus === "failed") throw new DeepReviewAnalysisFailedError();
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
