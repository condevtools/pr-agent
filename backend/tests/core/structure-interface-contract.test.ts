import assert from "node:assert/strict";
import test from "node:test";
import "reflect-metadata";

import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";

import { app as githubApp } from "../../src/bootstrap/probot-app.js";
import { AppModule } from "../../src/app.module.js";

const EXPECTED_HTTP_ROUTES = [
  "GET /evaluation-datasets/:id",
  "GET /evaluation-datasets/:id/cases/:caseId/fixture",
  "GET /evolution/evaluations/:id",
  "GET /evolution/proposals/:id",
  "GET /evolution/releases",
  "GET /github/health",
  "GET /gitlab/health",
  "GET /health",
  "GET /metrics",
  "GET /runs/:id",
  "GET /runs/:id/artifact",
  "GET /runs/:id/events",
  "GET /runs/:id/events/stream",
  "GET /runs/:id/trace",
  "GET /webhook/events",
  "POST /evaluation-datasets",
  "POST /evaluation-datasets/:id/cases",
  "POST /evaluation-datasets/:id/freeze",
  "POST /evolution/evaluations",
  "POST /evolution/proposals",
  "POST /evolution/releases/approve",
  "POST /evolution/releases/qualify",
  "POST /evolution/releases/request",
  "POST /evolution/releases/revoke",
  "POST /evolution/releases/rollback",
  "POST /evolution/runs/:id/annotations",
  "POST /evolution/runs/:id/annotations/arbitrate",
  "POST /evolution/runs/:id/feedback",
  "POST /github/replay/:eventId",
  "POST /github/trigger",
  "POST /gitlab/replay/:eventId",
  "POST /gitlab/trigger",
  "POST /runs",
  "POST /runs/:id/commands/:kind",
  "POST /runs/:id/fix-approvals",
  "POST /runs/:id/fix-approvals/:approvalId/approve",
  "POST /runs/:id/fix-approvals/:approvalId/revoke",
  "POST /runs/:id/fix-relevance",
  "POST /runs/:id/fixes",
  "POST /runs/:id/model-calls/:callId/usage-reconciliations",
] as const;

const EXPECTED_GITHUB_APP_EVENTS = [
  "issue_comment.created",
  "issues.edited",
  "issues.opened",
  "pull_request.closed",
  "pull_request.edited",
  "pull_request.opened",
  "pull_request.synchronize",
  "pull_request_review_thread.resolved",
  "pull_request_review_thread.unresolved",
] as const;

test("preserves the public Nest HTTP method and path contract", () => {
  assert.deepEqual(collectHttpRoutes(AppModule), [...EXPECTED_HTTP_ROUTES]);
});

test("preserves the GitHub App event subscription contract", () => {
  const subscribed: string[] = [];
  const previousMode = process.env.HARNESS_PUBLICATION_MODE;
  process.env.HARNESS_PUBLICATION_MODE = "postgres";
  try {
    githubApp({
      log: { info: () => undefined },
      on: (event: string) => { subscribed.push(event); },
    } as never);
  } finally {
    if (previousMode === undefined) delete process.env.HARNESS_PUBLICATION_MODE;
    else process.env.HARNESS_PUBLICATION_MODE = previousMode;
  }

  assert.deepEqual(subscribed.sort(), [...EXPECTED_GITHUB_APP_EVENTS]);
});

function collectHttpRoutes(rootModule: Function): string[] {
  const modules = new Set<Function>();
  const routes: string[] = [];

  const visit = (module: Function): void => {
    if (modules.has(module)) return;
    modules.add(module);

    const controllers = (Reflect.getMetadata("controllers", module) as Function[] | undefined) ?? [];
    for (const controller of controllers) {
      const controllerPath = metadataPath(controller);
      for (const property of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = controller.prototype[property] as Function | undefined;
        if (typeof handler !== "function") continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        const handlerPath = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        if (method === undefined || handlerPath === undefined) continue;
        routes.push(`${RequestMethod[method]} ${joinRoute(controllerPath, handlerPath)}`);
      }
    }

    const imports = (Reflect.getMetadata("imports", module) as unknown[] | undefined) ?? [];
    for (const imported of imports) {
      if (typeof imported === "function") visit(imported);
    }
  };

  visit(rootModule);
  return routes.sort();
}

function metadataPath(target: Function): string {
  const value = Reflect.getMetadata(PATH_METADATA, target) as string | undefined;
  return value ?? "";
}

function joinRoute(controllerPath: string, handlerPath: string): string {
  const segments = [controllerPath, handlerPath]
    .flatMap((value) => value.split("/"))
    .filter(Boolean);
  return `/${segments.join("/")}`;
}
