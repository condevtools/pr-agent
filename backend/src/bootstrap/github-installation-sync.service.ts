import { Injectable, type OnApplicationBootstrap } from "@nestjs/common";

import { startGitHubInstallationReconciler } from "../agent-runtime/runtime/github-onboarding.js";

/** Starts web-owned installation reconciliation after Nest providers are initialized. */
@Injectable()
export class GitHubInstallationSyncService implements OnApplicationBootstrap {
  async onApplicationBootstrap(): Promise<void> {
    await startGitHubInstallationReconciler();
  }
}
