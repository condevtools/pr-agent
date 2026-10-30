import "dotenv/config";
import "reflect-metadata";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { json, urlencoded } from "express";
import { readOptionalStringEnv } from "#core";
import type { RawBodyRequest } from "./http/common/types/raw-body-request.js";
import { requireOnlinePublicationAuthority } from "./agent-runtime/publication/mode.js";
import { resolveAgentProcessRole, roleStartsWeb } from "./agent-runtime/runtime/config.js";
import { runtimeComposition } from "./agent-runtime/runtime/composition.js";
import { beginModelShutdown, drainModelRequests } from "#model";
import { beginHttpShutdown } from "#core";

async function bootstrap(): Promise<void> {
  requireOnlinePublicationAuthority();
  const role = resolveAgentProcessRole();
  const runtime = runtimeComposition();
  await runtime.start(role);

  if (!roleStartsWeb(role)) {
    Logger.log(`PR Agent ${role} process started`, "Bootstrap");
    await waitForRuntimeShutdown(role, runtime.close.bind(runtime));
    return;
  }

  const { AppModule } = await import("./app.module.js");
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    rawBody: true,
  });
  const bodyLimit = resolveWebhookBodyLimit(readOptionalStringEnv("WEBHOOK_BODY_LIMIT"));
  app.use(
    json({
      limit: bodyLimit,
      verify: captureRawBody,
    }),
  );
  app.use(
    urlencoded({
      extended: true,
      limit: bodyLimit,
      verify: captureRawBody,
    }),
  );
  app.enableShutdownHooks();

  const port = resolvePort(readOptionalStringEnv("PORT"));
  await app.listen(port);

  Logger.log(`PR Agent ${role} listening on port ${port}`, "Bootstrap");
}

async function waitForRuntimeShutdown(
  role: ReturnType<typeof resolveAgentProcessRole>,
  closeRuntime: () => Promise<void>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const shutdown = async (signal: string) => {
      if (stopping) return;
      stopping = true;
      try {
        beginHttpShutdown();
        await closeRuntime();
        beginModelShutdown();
        await drainModelRequests();
        Logger.log(`PR Agent ${role} stopped (${signal})`, "Bootstrap");
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    process.once("SIGINT", () => { void shutdown("SIGINT"); });
    process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  });
}

function resolvePort(rawPort: string | undefined): number {
  const parsed = Number(rawPort);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return 3000;
  }

  return Math.floor(parsed);
}

function captureRawBody(
  request: RawBodyRequest,
  _response: unknown,
  buffer: Buffer,
): void {
  request.rawBody = buffer;
}

function resolveWebhookBodyLimit(rawLimit: string | undefined): string {
  const value = rawLimit?.trim();
  if (!value) {
    return "1mb";
  }

  return value;
}

bootstrap().catch(async (error) => {
  await runtimeComposition().close().catch(() => undefined);
  Logger.error(
    `Failed to bootstrap application: ${error instanceof Error ? error.message : String(error)}`,
    "",
    "Bootstrap",
  );
  process.exitCode = 1;
});
