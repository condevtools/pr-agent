import {
  Inject,
  Injectable,
  Logger,
  Optional,
  OnModuleInit,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { Express, RequestHandler } from "express";
import { createNodeMiddleware, createProbot } from "probot";
import { readOptionalStringEnv } from "@mr-agent/core";

import { app as githubApp } from "../../app.js";

@Injectable()
export class GithubAppBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(GithubAppBootstrapService.name);

  constructor(
    @Optional()
    @Inject(HttpAdapterHost)
    private readonly httpAdapterHost?: HttpAdapterHost,
  ) {}

  onModuleInit(): void {
    const httpAdapter = this.httpAdapterHost?.httpAdapter;
    if (!httpAdapter) {
      this.logger.warn(
        "HTTP adapter is not ready; skip mounting GitHub App webhook middleware.",
      );
      return;
    }

    const expressApp = httpAdapter.getInstance() as Express;
    if (!isGitHubAppEnabled()) {
      this.logger.warn(
        "GitHub App mode disabled (missing APP_ID/PRIVATE_KEY/WEBHOOK_SECRET). Plain webhook mode is still available.",
      );
      return;
    }

    const probot = createProbot();
    const middleware = createNodeMiddleware(githubApp, {
      probot,
      webhooksPath: "/api/github/webhooks",
    });

    const expressMiddleware: RequestHandler = (
      request,
      response,
      next,
    ) => {
      void (middleware as (...args: unknown[]) => unknown)(
        request,
        response,
        next,
      );
    };
    expressApp.use(expressMiddleware);
    this.logger.log("GitHub App webhook mounted at /api/github/webhooks");
  }
}

function isGitHubAppEnabled(): boolean {
  const appId = readOptionalStringEnv("APP_ID");
  const privateKey = readOptionalStringEnv("PRIVATE_KEY");
  const privateKeyPath = readOptionalStringEnv("PRIVATE_KEY_PATH");
  const webhookSecret = readOptionalStringEnv("WEBHOOK_SECRET");

  return Boolean(appId && (privateKey || privateKeyPath) && webhookSecret);
}
