import "dotenv/config";
import "reflect-metadata";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { json, urlencoded } from "express";
import { createServer } from "node:net";
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

  const rawPort = readOptionalStringEnv("PORT");
  const port = resolvePort(rawPort);
  const listeningPort = await listenWithFallback(app, port, !rawPort?.trim());

  Logger.log(`MR Agent listening on port ${listeningPort}`, "Bootstrap");
}

function resolvePort(rawPort: string | undefined): number {
  const parsed = Number(rawPort);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return 3000;
  }

  return Math.floor(parsed);
}

async function listenWithFallback(
  app: { listen(port: number): Promise<void> },
  initialPort: number,
  allowFallback: boolean,
): Promise<number> {
  const maxAttempts = 20;
  let selectedPort = initialPort;

  if (allowFallback) {
    const resolved = await resolveAvailablePort(initialPort, maxAttempts);
    if (resolved !== initialPort) {
      Logger.warn(
        `Port ${initialPort} is in use, switching to available port ${resolved}`,
        "Bootstrap",
      );
    }
    selectedPort = resolved;
  }

  await app.listen(selectedPort);
  return selectedPort;
}

async function resolveAvailablePort(
  initialPort: number,
  maxAttempts: number,
): Promise<number> {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = initialPort + offset;
    if (await canBindPort(port)) {
      return port;
    }
  }

  throw new Error(
    `No available port found from ${initialPort} to ${initialPort + maxAttempts - 1}`,
  );
}

async function canBindPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();

    const cleanup = (): void => {
      probe.removeAllListeners();
    };

    probe.once("error", () => {
      cleanup();
      resolve(false);
    });

    probe.once("listening", () => {
      probe.close(() => {
        cleanup();
        resolve(true);
      });
    });

    probe.listen(port, "0.0.0.0");
  });
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
