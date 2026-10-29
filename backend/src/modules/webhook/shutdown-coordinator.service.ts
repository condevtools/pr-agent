import { Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";

import { beginHttpShutdown } from "#core";
import { beginAiShutdown, drainAiRequests } from "#review";
import { closeAgentRuntime, stopPublicationRecovery, stopRunWorker } from "../../agent-runtime/runtime.js";

@Injectable()
export class ShutdownCoordinatorService implements OnApplicationShutdown {
  private readonly logger = new Logger(ShutdownCoordinatorService.name);

  async onApplicationShutdown(signal?: string): Promise<void> {
    beginHttpShutdown();
    await stopRunWorker();
    await stopPublicationRecovery();
    beginAiShutdown();
    const drained = await drainAiRequests();
    await closeAgentRuntime();
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
