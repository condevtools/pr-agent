import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import "reflect-metadata";

import { SystemController } from "../../src/http/system/system.controller.js";
import { AppModule } from "../../src/app.module.js";
import { HealthService } from "../../src/http/system/health.service.js";
import { SystemModule } from "../../src/http/system/system.module.js";
import { HttpErrorFilter } from "../../src/http/common/filters/http-error.filter.js";
import { BadWebhookRequestError } from "../../src/core/errors/errors.js";
import { GithubWebhookController } from "../../src/http/webhooks/github/github-webhook.controller.js";
import { GithubWebhookService } from "../../src/http/webhooks/github/github-webhook.service.js";
import { GitlabWebhookController } from "../../src/http/webhooks/gitlab/gitlab-webhook.controller.js";
import { GitlabWebhookService } from "../../src/http/webhooks/gitlab/gitlab-webhook.service.js";
import { clearMetricState } from "../support/metrics-test-api.ts";

interface MockResponse {
  statusCode?: number;
  body?: unknown;
  status: (code: number) => MockResponse;
  json: (payload: unknown) => void;
}

test("nestjs module metadata declares expected imports/controllers/providers", () => {
  const imports = (Reflect.getMetadata("imports", AppModule) as unknown[]) ?? [];
  const controllers = (Reflect.getMetadata("controllers", SystemModule) as unknown[]) ?? [];
  const providers = (Reflect.getMetadata("providers", SystemModule) as unknown[]) ?? [];

  assert.ok(imports.length >= 2);
  assert.ok(imports.includes(SystemModule));
  assert.ok(controllers.includes(SystemController));
  assert.ok(providers.includes(HealthService));
});

test("nestjs controllers expose health/metrics and validate webhook payloads", async () => {
  clearMetricState();
  const appController = new SystemController(new HealthService());
  const githubController = new GithubWebhookController(new GithubWebhookService());
  const gitlabController = new GitlabWebhookController(new GitlabWebhookService());

  const health = await appController.health();
  assert.equal(health.ok, true);

  const metrics = appController.metrics();
  assert.match(metrics, /pr_agent_process_uptime_seconds/);

  const githubHealth = await githubController.health();
  assert.equal(githubHealth.ok, true);

  const gitlabHealth = await gitlabController.health();
  assert.equal(gitlabHealth.ok, true);

  const previousSecret = process.env.GITHUB_WEBHOOK_SECRET;
  process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
  try {
    await assert.rejects(
      () =>
        githubController.trigger(
          {
            body: {},
            rawBody: "{}",
          } as never,
          {
            "content-type": "application/json",
            "x-hub-signature-256": `sha256=${createHmac("sha256", "test-webhook-secret").update("{}").digest("hex")}`,
          },
        ),
      /missing x-github-event header/i,
    );
  } finally {
    if (previousSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = previousSecret;
  }

  await assert.rejects(
    () =>
      gitlabController.trigger(
        {
          body: {},
        } as never,
        {
          "content-type": "application/json",
        },
      ),
    /invalid gitlab payload/i,
  );
});

test("http error filter serializes webhook errors consistently", () => {
  const filter = new HttpErrorFilter();
  const response = createMockResponse();
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({
        originalUrl: "/github/trigger",
        method: "POST",
      }),
    }),
  };

  filter.catch(new BadWebhookRequestError("invalid webhook payload"), host as never);

  assert.equal(response.statusCode, 400);
  const body = response.body as {
    ok?: boolean;
    type?: string;
    path?: string;
    method?: string;
  };
  assert.equal(body.ok, false);
  assert.equal(body.type, "BadWebhookRequestError");
  assert.equal(body.path, "/github/trigger");
  assert.equal(body.method, "POST");
});

function createMockResponse(): MockResponse {
  const response: MockResponse = {
    statusCode: undefined,
    body: undefined,
    status(code: number): MockResponse {
      response.statusCode = code;
      return response;
    },
    json(payload: unknown): void {
      response.body = payload;
    },
  };
  return response;
}
