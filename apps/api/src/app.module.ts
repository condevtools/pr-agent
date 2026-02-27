import { Module } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";

import { AppController } from "./app.controller.js";
import { AppService } from "./app.service.js";
import { HttpErrorFilter } from "./common/filters/http-error.filter.js";
import { TimeoutInterceptor } from "./common/interceptors/timeout.interceptor.js";
import { DatabaseModule } from "./modules/database/database.module.js";
import { GithubAppModule } from "./modules/github-app/github-app.module.js";
import { GithubModule } from "./modules/github/github.module.js";
import { GitlabModule } from "./modules/gitlab/gitlab.module.js";
import { ShutdownCoordinatorService } from "./modules/webhook/shutdown-coordinator.service.js";

@Module({
  imports: [DatabaseModule, GithubModule, GitlabModule, GithubAppModule],
  controllers: [AppController],
  providers: [
    AppService,
    ShutdownCoordinatorService,
    {
      provide: APP_FILTER,
      useClass: HttpErrorFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: TimeoutInterceptor,
    },
  ],
})
export class AppModule {}
