import { randomUUID } from "node:crypto";
import { FixProposalFailedError } from "./fix-proposal-run.js";

import type { PublicationBinding } from "./authority.js";
import { createBudgetedModelExecutionContext, ModelBudgetExceededError, type ModelBudgetStore, type ModelExecutionPolicy } from "./model-budget-store.js";
import { withModelExecutionContext } from "./model-execution-context.js";
import { PendingPublicationError, PublicationDefiniteFailureError, StalePublicationError } from "./publication.js";
import { RunCheckpointCompatibilityError, RunLeaseLostError, type RunLease, type RunStepKind } from "./run-contracts.js";
import type { RunExecutionStore } from "./run-execution-store.js";
import { DeepReviewAnalysisFailedError, ReviewRunRevisionChangedError, withReviewRunContext, type ReviewRunExecutionContext } from "./review-run-context.js";
import { fingerprint, REVIEW_RUNTIME_CONFIG } from "./versions.js";
import type { PublicationOutcomeHandler } from "./publication-outcome.js";

interface WorkerDependencies {
  store: RunExecutionStore;
  budget: ModelBudgetStore;
  bindings(): Promise<PublicationBinding[]>;
  runtimeHash(binding: PublicationBinding): Promise<string>;
  execute(lease: RunLease, binding: PublicationBinding): Promise<void>;
  outcomeHandler?: PublicationOutcomeHandler;
  coordinateOutcomes?(binding: PublicationBinding): Promise<unknown>;
  onError(error: unknown, runId?: string): void;
}

export class ReviewRunWorker {
  private readonly owner = `review-worker-${randomUUID()}`;
  private readonly active = new Map<string, { task: Promise<void>; controller: AbortController }>();
  private timer?: NodeJS.Timeout;
  private sweeper?: NodeJS.Timeout;
  private polling = false;
  private sweeping = false;
  private stopped = false;

  constructor(private readonly dependencies: WorkerDependencies, private readonly concurrency = 4) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
      throw new Error("Invalid Run worker concurrency");
    }
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const poll = () => {
      void this.tick().catch((error: unknown) => this.dependencies.onError(error));
    };
    const sweep = () => {
      void this.sweep().catch((error: unknown) => this.dependencies.onError(error));
    };
    poll();
    sweep();
    this.timer = setInterval(poll, REVIEW_RUNTIME_CONFIG.pollMs);
    this.sweeper = setInterval(sweep, REVIEW_RUNTIME_CONFIG.sweepMs);
    this.timer.unref();
    this.sweeper.unref();
  }

  async tick(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      for (const binding of await this.dependencies.bindings()) {
        if (this.stopped || this.active.size >= this.concurrency) break;
        if (binding.reviewExecutionMode !== "harness_async") continue;
        const runtimeHash = await this.dependencies.runtimeHash(binding);
        while (!this.stopped && this.active.size < this.concurrency) {
          const lease = await this.dependencies.store.claimPublicationOutcome(
            claimBinding(binding), this.owner, runtimeHash,
          ) ?? await this.dependencies.store.claimManualResume(
            claimBinding(binding), this.owner, runtimeHash,
          ) ?? await this.dependencies.store.claim(claimBinding(binding), this.owner, runtimeHash);
          if (!lease) break;
          const controller = new AbortController();
          const task = this.execute(lease, binding, controller)
            .catch((error: unknown) => this.dependencies.onError(error, lease.runId))
            .finally(() => {
              if (this.active.get(lease.runId)?.controller === controller) {
                this.active.delete(lease.runId);
              }
            });
          this.active.set(lease.runId, { task, controller });
        }
      }
    } finally {
      this.polling = false;
    }
  }

  async sweep(): Promise<void> {
    if (this.sweeping || this.stopped) return;
    this.sweeping = true;
    try {
      for (const binding of await this.dependencies.bindings()) {
        if (binding.reviewExecutionMode === "harness_async") {
          await this.dependencies.store.sweep(claimBinding(binding));
          await this.dependencies.coordinateOutcomes?.(binding);
        }
        await this.dependencies.budget.closeTerminalBudgets(binding.tenantId);
      }
    } finally {
      this.sweeping = false;
    }
  }

  async drain(): Promise<void> {
    await Promise.all([...this.active.values()].map(({ task }) => task));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.sweeper);
    this.timer = undefined;
    this.sweeper = undefined;
    for (const { controller } of this.active.values()) {
      controller.abort(new Error("Run worker stopped"));
    }
    // In-flight database claims finish before closing the shared pool.
    while (this.polling || this.sweeping) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const { controller } of this.active.values()) {
      controller.abort(new Error("Run worker stopped"));
    }
    await this.drain();
  }

  private async execute(lease: RunLease, binding: PublicationBinding, controller: AbortController): Promise<void> {
    const store = this.dependencies.store;
    let active = true;
    let heartbeating = false;
    const heartbeat = setInterval(() => {
      if (heartbeating || !active || controller.signal.aborted) return;
      heartbeating = true;
      void store.heartbeat(lease).catch((error: unknown) => {
        controller.abort(error);
        this.dependencies.onError(error, lease.runId);
      }).finally(() => {
        heartbeating = false;
      });
    }, REVIEW_RUNTIME_CONFIG.heartbeatMs);
    heartbeat.unref();

    const assertActive = async () => {
      if (!active || controller.signal.aborted) throw new RunLeaseLostError(lease.runId);
      await store.withLease(lease, async (client) => {
        if (lease.input.workflow === "review.deep.v1" || String(lease.input.workflow).startsWith("fix.")) {
          const authority = await client.query<{ allowed: boolean }>(
            "SELECT pr_agent_harness.lock_resumable_review_execution_authority($1,$2,$3,$4) AS allowed",
            [lease.tenantId, lease.integrationId, lease.authorityGeneration, lease.executionModeGeneration],
          );
          if (!authority.rows[0]?.allowed) throw new RunLeaseLostError(lease.runId);
        }
      });
    };
    const context: ReviewRunExecutionContext = {
      lease,
      signal: controller.signal,
      assertActive,
      step: async <T>(
        key: string,
        kind: RunStepKind,
        inputHash: string,
        action: () => Promise<T>,
      ): Promise<T> => {
        await assertActive();
        const step = await store.beginStep(lease, {
          stepKey: key,
          kind,
          inputHash,
          ...(kind === "tool"
            ? { tool: { name: deepToolName(key) ?? key, kind: deepToolName(key) ? "repository_read" as const : "provider_read" as const, requestHash: inputHash } }
            : {}),
        });
        if (step.reused) {
          if (!step.output || fingerprint(step.output) !== step.outputHash || !("value" in step.output)) {
            throw new RunCheckpointCompatibilityError(lease.runId);
          }
          return step.output.value as T;
        }
        try {
        const policy = lease.runtimeConfig.modelPolicy as ModelExecutionPolicy;
        const result = kind === "model"
          ? await withModelExecutionContext(
            {
              ...createBudgetedModelExecutionContext({
                store: this.dependencies.budget,
                lease,
                stepId: step.id,
                stepAttemptId: step.attemptId,
                policy,
              }),
              signal: controller.signal,
            },
            action,
          )
          : await action();
        await assertActive();
        const output = JSON.parse(JSON.stringify({ value: result })) as Record<string, unknown>;
        if (Buffer.byteLength(JSON.stringify(output)) > REVIEW_RUNTIME_CONFIG.maxCheckpointBytes) {
          throw new Error("Run checkpoint exceeds its frozen size limit");
        }
        const state = { stage: key, stepId: step.id, outputHash: fingerprint(output) };
        await store.completeStep(lease, {
          stepId: step.id,
          attemptId: step.attemptId,
          output,
          outputHash: fingerprint(output),
          checkpoint: { schemaVersion: 1, state, stateHash: fingerprint(state) },
        });
        return result;
        } catch (error) {
          if (!(error instanceof RunLeaseLostError) && !controller.signal.aborted) {
            await store.failStep(lease, { stepId: step.id, attemptId: step.attemptId,
              errorCode: error instanceof Error ? error.name.slice(0, 128) : "StepFailed" });
          }
          throw error;
        }
      },
    };
    try {
      if (lease.jobKind === "publication_outcome" || lease.jobKind === "manual_resume") {
        if (!this.dependencies.outcomeHandler) {
          throw new Error("publication outcome handler is not configured");
        }
        await this.dependencies.outcomeHandler.execute(lease);
        return;
      }
      await store.latestCheckpoint(lease, { schemaVersion: 1, runtimeVersionHash: lease.runtimeVersionHash });
      await withReviewRunContext(context, () => this.dependencies.execute(lease, binding));
      await assertActive();
      if (lease.input.workflow !== "fix.publish.v1") await this.dependencies.budget.closeRunBudget(lease);
      await store.transition(lease, { to: "succeeded", outcomeCode: lease.input.workflow === "review.deep.v1"
        ? "deep_review_artifact_completed" : lease.input.workflow === "fix.propose.v1"
          ? "fix_proposal_completed" : lease.input.workflow === "fix.publish.v1" ? "fix_publication_completed" : "review_completed" });
    } catch (error) {
      if (error instanceof RunLeaseLostError || controller.signal.aborted) return;
      if (lease.jobKind === "publication_outcome" || lease.jobKind === "manual_resume") {
        await store.retrySpecialJob(
          lease,
          1_000,
          error instanceof Error ? error.name : "publication_outcome_retry",
        );
        this.dependencies.onError(error, lease.runId);
        return;
      }
      if (error instanceof PendingPublicationError) {
        await store.transition(lease, { to: "waiting_for_reconciliation", reasonCode: "publication_pending" });
      } else if (
        error instanceof PublicationDefiniteFailureError ||
        error instanceof StalePublicationError ||
        error instanceof ReviewRunRevisionChangedError ||
        error instanceof DeepReviewAnalysisFailedError ||
        error instanceof FixProposalFailedError ||
        error instanceof ModelBudgetExceededError ||
        error instanceof RunCheckpointCompatibilityError ||
        lease.jobAttempt >= REVIEW_RUNTIME_CONFIG.maxJobAttempts
      ) {
        if (lease.input.workflow !== "fix.publish.v1") await this.dependencies.budget.closeRunBudget(lease);
        await store.transition(lease, {
          to: "failed",
          reasonCode: error instanceof Error ? error.name : "review_failed",
        });
      } else {
        await store.transition(lease, {
          to: "retry_wait",
          reasonCode: error instanceof Error ? error.name : "review_retry",
          retryDelayMs: 1_000,
        });
      }
      this.dependencies.onError(error, lease.runId);
    } finally {
      active = false;
      controller.abort();
      clearInterval(heartbeat);
      while (heartbeating) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }
}

function claimBinding(binding: PublicationBinding) {
  return {
    tenantId: binding.tenantId,
    integrationId: binding.id,
    authorityGeneration: binding.generation,
    executionModeGeneration: binding.executionModeGeneration ?? 0,
  };
}

function deepToolName(key: string): string | undefined {
  return /^deep\.role\.(?:security|correctness)\.tool\.(read_file_range|search_changed_files|find_symbol_references|read_manifest|read_ci_status)\.\d+$/.exec(key)?.[1];
}
