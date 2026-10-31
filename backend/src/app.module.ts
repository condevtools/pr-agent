import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";

import { SystemModule } from "./http/system/system.module.js";
import { WebhookEventsModule } from "./http/webhooks/webhook-events.module.js";
import { FixesModule } from "./http/fixes/fixes.module.js";
import { EvolutionModule } from "./http/evolution/evolution.module.js";
import { HttpErrorFilter } from "./http/common/filters/http-error.filter.js";
import { GithubAppModule } from "./bootstrap/github-app/github-app.module.js";
import { GithubModule } from "./http/webhooks/github/github.module.js";
import { GitlabModule } from "./http/webhooks/gitlab/gitlab.module.js";
import { ShutdownCoordinatorService } from "./bootstrap/shutdown-coordinator.service.js";
import { AgentRuntimeModule } from "./http/runs/agent-runtime.module.js";
import { GitHubInstallationSyncService } from "./bootstrap/github-installation-sync.service.js";

@Module({
  imports: [GithubModule, GitlabModule, GithubAppModule, AgentRuntimeModule,
    FixesModule, EvolutionModule, SystemModule, WebhookEventsModule],
  providers: [
    GitHubInstallationSyncService,
    ShutdownCoordinatorService,
    {
      provide: APP_FILTER,
      useClass: HttpErrorFilter,
    },
  ],
})
export class AppModule {}
