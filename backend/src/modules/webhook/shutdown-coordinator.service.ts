import { Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";

import { beginHttpShutdown } from "#core";
import { beginAiShutdown, drainAiRequests } from "#review";
import { closeHarnessRuntime, stopHarnessRecovery, stopReviewRunWorker } from "../../harness/runtime.js";

@Injectable()
export class ShutdownCoordinatorService implements OnApplicationShutdown {
  private readonly logger = new Logger(ShutdownCoordinatorService.name);

  async onApplicationShutdown(signal?: string): Promise<void> {
    beginHttpShutdown();
    await stopReviewRunWorker();
    await stopHarnessRecovery();
    beginAiShutdown();
    const drained = await drainAiRequests();
    await closeHarnessRuntime();
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
