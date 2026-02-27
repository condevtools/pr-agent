import "dotenv/config";
import "reflect-metadata";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { json, urlencoded } from "express";
import { prepareRuntimeStateBackend, readOptionalStringEnv } from "@mr-agent/core";
import { AppModule } from "./app.module.js";
import type { RawBodyRequest } from "./common/types/raw-body-request.js";

async function bootstrap(): Promise<void> {
  await prepareRuntimeStateBackend();

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

  Logger.log(`MR Agent listening on port ${port}`, "Bootstrap");
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

bootstrap().catch((error) => {
  Logger.error(
    `Failed to bootstrap application: ${error instanceof Error ? error.message : String(error)}`,
    "",
    "Bootstrap",
  );
  process.exit(1);
});
