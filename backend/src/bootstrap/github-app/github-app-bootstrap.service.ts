import {
  Injectable,
  OnModuleInit,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { Express, RequestHandler } from "express";
import { createNodeMiddleware } from "probot";
import { logCore, readOptionalStringEnv } from "#core";

import { app as githubApp } from "../probot-app.js";
import { getSharedGitHubProbot } from "../../agent-runtime/runtime/credentials.js";

@Injectable()
export class GithubAppBootstrapService implements OnModuleInit {
  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  onModuleInit(): void {
    const httpAdapter = this.httpAdapterHost?.httpAdapter;
    if (!httpAdapter) {
      return;
    }

    const expressApp = httpAdapter.getInstance() as Express;
    if (!isGitHubAppEnabled()) {
      logCore("warn", "github_app.disabled", { domainCode: "GITHUB_APP_CONFIGURATION_MISSING" });
      return;
    }

    const probot = getSharedGitHubProbot();
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
    logCore("info", "github_app.webhook_mounted", { path: "/api/github/webhooks" });
  }
}

function isGitHubAppEnabled(): boolean {
  const appId = readOptionalStringEnv("APP_ID");
  const privateKey = readOptionalStringEnv("PRIVATE_KEY");
  const privateKeyPath = readOptionalStringEnv("PRIVATE_KEY_PATH");
  const webhookSecret = readOptionalStringEnv("WEBHOOK_SECRET");

  return Boolean(appId && (privateKey || privateKeyPath) && webhookSecret);
}
