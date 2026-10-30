import { EvaluationCoordinator } from "../../evolution/evaluations/run.js";
import { PgEvolutionEvaluationStore } from "../../evolution/evaluations/store.js";
import { ModelBudgetStore } from "../budget/model-budget-store.js";
import { RunWorker } from "../execution/run-worker.js";
import { RunExecutionStore } from "../execution/store.js";
import { PublicationControlStore } from "../publication/control.js";
import { PublicationOutcomeCoordinator, PublicationOutcomeHandler } from "../publication/outcome.js";
import { createPublicationRecoveryLoop, type PublicationRecoveryLoop } from "../publication/recovery.js";
import { loadFixPolicyRegistry } from "../../fix/proposal/policy.js";
import { roleStartsRecovery, roleStartsWorker, type AgentProcessRole } from "./config.js";
import { bindingAllowsCapability, resolveRuntimeCapabilities, supportedWorkflowIds,
  supportedWorkflowIdsForBinding,
  type RuntimeCapabilityConfiguration } from "./capabilities.js";
import { clearSharedCredentialRuntime } from "./credentials.js";
import { ProcessHeartbeatLoop, ProcessHeartbeatStore, resolveProcessHeartbeatConfiguration } from "./heartbeat.js";
import { publicationRuntimeForBinding } from "./publication.js";
import { closeApplicationRuntimeServices, createAgentRuntimeServices, withAgentRuntimeServices,
  type AgentRuntimeServices } from "./services.js";
import { createWorkflowRegistry, workflowExecutor, type WorkflowExecutor } from "./workflows.js";
import { resolveWorkerCompatibility, type WorkerCompatibility } from "./worker-compatibility.js";

export { supportedWorkflowIds } from "./capabilities.js";

export interface RuntimeRoleStatus {
  role: "worker" | "recovery";
  state: "stopped" | "starting" | "running" | "stopping" | "failed";
  startedAt?: string;
  stoppedAt?: string;
  lastErrorAt?: string;
  lastErrorType?: string;
  lastActivityAt?: string;
}

export class AgentRuntimeComposition {
  private worker?: { services: AgentRuntimeServices; loop: RunWorker; heartbeat: ProcessHeartbeatLoop };
  private recovery?: { services: AgentRuntimeServices; loop: PublicationRecoveryLoop; heartbeat: ProcessHeartbeatLoop };
  private readonly statuses = new Map<"worker" | "recovery", RuntimeRoleStatus>([
    ["worker", { role: "worker", state: "stopped" }],
    ["recovery", { role: "recovery", state: "stopped" }],
  ]);
  private readonly execute: WorkflowExecutor;
  private capabilities?: RuntimeCapabilityConfiguration;

  constructor(registry = createWorkflowRegistry()) { this.execute = workflowExecutor(registry); }

  async start(role: AgentProcessRole): Promise<void> {
    this.capabilities = validateCapabilityDependencies();
    resolveProcessHeartbeatConfiguration();
    if (roleStartsRecovery(role)) await this.startRecovery();
    if (roleStartsWorker(role)) await this.startWorker();
  }

  status(): RuntimeRoleStatus[] { return [...this.statuses.values()].map((status) => ({ ...status })); }

  async startRecovery(): Promise<void> {
    if (this.recovery) return;
    this.setStatus("recovery", "starting");
    const services = createAgentRuntimeServices();
    let heartbeat: ProcessHeartbeatLoop | undefined;
    try {
      await services.assertRole();
      const activeHeartbeat = this.processHeartbeat(services, "recovery");
      heartbeat = activeHeartbeat;
      await activeHeartbeat.start();
      const loop = createPublicationRecoveryLoop({
        db: services.db, authority: services.authority,
        batchStore: services.batchStore, batchCoordinator: services.batchCoordinator,
        runtimeForBinding: (binding) => publicationRuntimeForBinding(binding, services),
        onActivity: () => {
          this.recordActivity("recovery");
          void activeHeartbeat.recordActivity().catch((error) => this.recordError("recovery", error));
        },
        onError: (error, context) => {
          this.recordError("recovery", error);
          process.emitWarning(JSON.stringify({ component: "publication-recovery", ...context,
            errorType: error instanceof Error ? error.name : "unknown" }));
        },
      });
      this.recovery = { services, loop, heartbeat: activeHeartbeat };
      loop.start();
      this.setStatus("recovery", "running");
    } catch (error) {
      this.recordError("recovery", error, "failed");
      await heartbeat?.stop().catch((stopError) => this.recordError("recovery", stopError, "failed"));
      await services.close();
      throw error;
    }
  }

  async startWorker(): Promise<void> {
    if (this.worker) return;
    this.setStatus("worker", "starting");
    const services = createAgentRuntimeServices();
    let heartbeat: ProcessHeartbeatLoop | undefined;
    try {
      await services.assertRole();
      const capabilities = this.capabilities ?? validateCapabilityDependencies();
      const compatibility = await resolveWorkerCompatibility(capabilities);
      const activeHeartbeat = this.processHeartbeat(services, "worker", compatibility);
      heartbeat = activeHeartbeat;
      await activeHeartbeat.start();
      const store = new RunExecutionStore(services.db, {
        supportedWorkflows: compatibility.supportedWorkflowIds,
      });
      const budget = new ModelBudgetStore(services.db);
      const outcomes = new PublicationOutcomeCoordinator({ db: services.db, batchStore: services.batchStore });
      const evaluations = new EvaluationCoordinator(new PgEvolutionEvaluationStore(services.db));
      const outcomeHandler = new PublicationOutcomeHandler({
        store, budget, batchStore: services.batchStore, batchCoordinator: services.batchCoordinator,
        control: new PublicationControlStore(services.db),
        createAdapter: async (operation) => {
          const binding = await services.authority.get(operation.scope.tenantId, operation.scope.integrationId);
          return (await publicationRuntimeForBinding(binding, services)).createAdapter(operation);
        },
      });
      const loop = new RunWorker({
        store, budget, outcomeHandler,
        coordinateOutcomes: async (binding) => {
          const tasks: Promise<unknown>[] = [outcomes.tick(binding)];
          if (bindingAllowsCapability(binding, "evolution", capabilities)) {
            tasks.push(evaluations.tick(binding));
          }
          const results = await Promise.allSettled(tasks);
          for (const result of results) if (result.status === "rejected") {
            this.recordError("worker", result.reason);
            process.emitWarning(JSON.stringify({ component: "harness-coordinator",
              errorType: result.reason instanceof Error ? result.reason.name : "unknown" }));
          }
        },
        bindings: async () => {
          const bindings = await services.authority.listRecoverable();
          this.recordActivity("worker");
          await activeHeartbeat.recordActivity();
          return bindings;
        },
        runtimeHash: async () => compatibility.runtimeVersionHash,
        supportedWorkflows: (binding) => supportedWorkflowIdsForBinding(
          capabilities, binding,
        ),
        execute: (lease, binding) => withAgentRuntimeServices(services, () => this.execute(lease, binding)),
        onError: (error, runId) => {
          this.recordError("worker", error);
          process.emitWarning(JSON.stringify({ component: "review-run-worker", runId,
            errorType: error instanceof Error ? error.name : "unknown" }));
        },
      });
      this.worker = { services, loop, heartbeat: activeHeartbeat };
      loop.start();
      this.setStatus("worker", "running");
    } catch (error) {
      this.recordError("worker", error, "failed");
      await heartbeat?.stop().catch((stopError) => this.recordError("worker", stopError, "failed"));
      await services.close();
      throw error;
    }
  }

  async stopWorker(): Promise<void> {
    const current = this.worker;
    if (!current) return;
    this.worker = undefined;
    this.setStatus("worker", "stopping");
    try { await current.loop.stop(); }
    finally {
      await current.heartbeat.stop().catch((error) => this.recordError("worker", error));
      await current.services.close(); this.setStatus("worker", "stopped");
    }
  }

  async stopRecovery(): Promise<void> {
    const current = this.recovery;
    if (!current) return;
    this.recovery = undefined;
    this.setStatus("recovery", "stopping");
    try { await current.loop.stop(); }
    finally {
      await current.heartbeat.stop().catch((error) => this.recordError("recovery", error));
      await current.services.close(); this.setStatus("recovery", "stopped");
    }
  }

  async quiesce(): Promise<void> {
    const results = await Promise.allSettled([
      this.stopWorker(),
      this.stopRecovery(),
    ]);
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length === 1) throw failures[0]!.reason;
    if (failures.length > 1) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Agent runtime background roles failed to quiesce",
      );
    }
  }

  async closeApplicationResources(): Promise<void> {
    await closeApplicationRuntimeServices();
    clearSharedCredentialRuntime();
  }

  async close(): Promise<void> {
    await this.quiesce();
    await this.closeApplicationResources();
  }

  executeRun(...args: Parameters<WorkflowExecutor>): ReturnType<WorkflowExecutor> { return this.execute(...args); }

  private setStatus(role: "worker" | "recovery", state: RuntimeRoleStatus["state"]): void {
    const previous = this.statuses.get(role)!;
    this.statuses.set(role, { ...previous, state,
      ...(state === "running" ? { startedAt: new Date().toISOString(), stoppedAt: undefined } : {}),
      ...(state === "stopped" ? { stoppedAt: new Date().toISOString() } : {}) });
  }

  private recordError(role: "worker" | "recovery", error: unknown,
    state: RuntimeRoleStatus["state"] = this.statuses.get(role)!.state): void {
    this.statuses.set(role, { ...this.statuses.get(role)!, state, lastErrorAt: new Date().toISOString(),
      lastErrorType: error instanceof Error ? error.name : "unknown" });
  }

  private recordActivity(role: "worker" | "recovery"): void {
    this.statuses.set(role, { ...this.statuses.get(role)!, lastActivityAt: new Date().toISOString() });
  }

  private processHeartbeat(
    services: AgentRuntimeServices,
    role: "worker" | "recovery",
    workerCompatibility?: WorkerCompatibility,
  ): ProcessHeartbeatLoop {
    return new ProcessHeartbeatLoop(
      new ProcessHeartbeatStore(services.pool),
      role,
      role === "worker" ? { schemaVersion: 2,
        capabilities: this.capabilities ?? validateCapabilityDependencies(),
        supportedWorkflowIds: workerCompatibility?.supportedWorkflowIds ?? [],
        runtimeVersionHash: workerCompatibility?.runtimeVersionHash ?? "" }
        : { schemaVersion: 1 },
      undefined,
      (error) => this.recordError(role, error),
      false,
    );
  }
}

const activeComposition = new AgentRuntimeComposition();
export function runtimeComposition(): AgentRuntimeComposition { return activeComposition; }

export function validateCapabilityDependencies(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeCapabilityConfiguration {
  const capabilities = resolveRuntimeCapabilities(env);
  if (capabilities.fix) {
    const policyId = env.FIX_DEFAULT_POLICY_ID!.trim();
    if (!loadFixPolicyRegistry(env.FIX_POLICY_REGISTRY_JSON).has(policyId)) {
      throw new Error("FEATURE_FIX=on requires FIX_DEFAULT_POLICY_ID in FIX_POLICY_REGISTRY_JSON");
    }
  }
  return capabilities;
}
