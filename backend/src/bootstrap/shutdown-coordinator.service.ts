import {
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
} from "@nestjs/common";

import { beginHttpShutdown, logCore } from "#core";
import { beginModelShutdown, drainModelRequests } from "#model";
import {
  closeAgentRuntimeApplicationResources,
  quiesceAgentRuntime,
} from "../agent-runtime/runtime.js";
import { closeGitHubOnboardingStore,
  stopGitHubInstallationReconciler } from "../agent-runtime/runtime/github-onboarding.js";

export interface ApplicationShutdownDependencies {
  beginHttpShutdown(): void;
  quiesceRuntime(): Promise<void>;
  quiesceGitHubOnboarding(): Promise<void>;
  closeApplicationResources(): Promise<void>;
  closeGitHubOnboardingResources(): Promise<void>;
  beginModelShutdown(): void;
  drainModelRequests(): Promise<boolean>;
}

export class ApplicationShutdownSequence {
  private quiescing?: Promise<void>;
  private closing?: Promise<boolean>;

  constructor(private readonly dependencies: ApplicationShutdownDependencies) {}

  beforeApplicationShutdown(): Promise<void> {
    this.quiescing ??= (async () => {
      this.dependencies.beginHttpShutdown();
      const failures: unknown[] = [];
      for (const task of [this.dependencies.quiesceRuntime, this.dependencies.quiesceGitHubOnboarding]) {
        try { await task(); } catch (error) { failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Application background work failed to quiesce");
    })();
    return this.quiescing;
  }

  onApplicationShutdown(): Promise<boolean> {
    this.closing ??= (async () => {
      await this.beforeApplicationShutdown();
      const failures: unknown[] = [];
      for (const task of [this.dependencies.closeApplicationResources,
        this.dependencies.closeGitHubOnboardingResources]) {
        try { await task(); } catch (error) { failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Application resources failed to close");
      this.dependencies.beginModelShutdown();
      return this.dependencies.drainModelRequests();
    })();
    return this.closing;
  }
}

@Injectable()
export class ShutdownCoordinatorService implements BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly sequence = new ApplicationShutdownSequence({
    beginHttpShutdown,
    quiesceRuntime: quiesceAgentRuntime,
    quiesceGitHubOnboarding: stopGitHubInstallationReconciler,
    closeApplicationResources: closeAgentRuntimeApplicationResources,
    closeGitHubOnboardingResources: closeGitHubOnboardingStore,
    beginModelShutdown,
    drainModelRequests,
  });

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    await this.sequence.beforeApplicationShutdown();
    logCore("info", "application.shutdown_claimers_drained", { signal: signal ?? "unknown" });
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    const drained = await this.sequence.onApplicationShutdown();
    if (!drained) {
      logCore("warn", "application.shutdown_model_drain_timeout", { signal: signal ?? "unknown" });
      return;
    }

    logCore("info", "application.shutdown_model_requests_drained", { signal: signal ?? "unknown" });
  }
}
