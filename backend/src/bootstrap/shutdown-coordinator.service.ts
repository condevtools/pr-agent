import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
} from "@nestjs/common";

import { beginHttpShutdown } from "#core";
import { beginModelShutdown, drainModelRequests } from "#model";
import {
  closeAgentRuntimeApplicationResources,
  quiesceAgentRuntime,
} from "../agent-runtime/runtime.js";

export interface ApplicationShutdownDependencies {
  beginHttpShutdown(): void;
  quiesceRuntime(): Promise<void>;
  closeApplicationResources(): Promise<void>;
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
      await this.dependencies.quiesceRuntime();
    })();
    return this.quiescing;
  }

  onApplicationShutdown(): Promise<boolean> {
    this.closing ??= (async () => {
      await this.beforeApplicationShutdown();
      await this.dependencies.closeApplicationResources();
      this.dependencies.beginModelShutdown();
      return this.dependencies.drainModelRequests();
    })();
    return this.closing;
  }
}

@Injectable()
export class ShutdownCoordinatorService implements BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger(ShutdownCoordinatorService.name);
  private readonly sequence = new ApplicationShutdownSequence({
    beginHttpShutdown,
    quiesceRuntime: quiesceAgentRuntime,
    closeApplicationResources: closeAgentRuntimeApplicationResources,
    beginModelShutdown,
    drainModelRequests,
  });

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    await this.sequence.beforeApplicationShutdown();
    this.logger.log(
      `Application shutdown (${signal ?? "unknown"}): background claimers drained`,
    );
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    const drained = await this.sequence.onApplicationShutdown();
    if (!drained) {
      this.logger.warn(
        `Application shutdown (${signal ?? "unknown"}): timed out while draining AI requests`,
      );
      return;
    }

    this.logger.log(
      `Application shutdown (${signal ?? "unknown"}): AI requests drained`,
    );
  }
}
