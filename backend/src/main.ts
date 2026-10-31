import "dotenv/config";
import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { json, urlencoded } from "express";
import { logCore, validateRuntimeEnvironment } from "#core";
import type { RawBodyRequest } from "./http/common/types/raw-body-request.js";
import { requireOnlinePublicationAuthority } from "./agent-runtime/publication/mode.js";
import { resolveAgentProcessRole, roleStartsWeb, roleStartsWorker } from "./agent-runtime/runtime/config.js";
import { runtimeComposition, validateCapabilityDependencies } from "./agent-runtime/runtime/composition.js";
import { resolveFrozenModelExecutionPolicy } from "./agent-runtime/runtime/worker-compatibility.js";
import { evolutionReleasePolicy } from "./evolution/releases/policy.js";
import { beginModelShutdown, drainModelRequests } from "#model";
import { beginHttpShutdown } from "#core";
import { initializeAgentObservability, shutdownAgentObservability } from "./observability/index.js";

async function bootstrap(): Promise<void> {
  requireOnlinePublicationAuthority();
  const role = resolveAgentProcessRole();
  const profiles = role === "all" ? ["web", "worker", "recovery"] as const : [role];
  const configurations = profiles.map((profile) => validateRuntimeEnvironment(process.env, profile));
  if (roleStartsWeb(role) || roleStartsWorker(role)) {
    const capabilities = validateCapabilityDependencies(process.env);
    if (roleStartsWeb(role)) resolveFrozenModelExecutionPolicy(process.env);
    if (capabilities.evolution) evolutionReleasePolicy(process.env);
  }
  if (roleStartsWorker(role)) initializeAgentObservability();
  const runtime = runtimeComposition();
  await runtime.start(role);

  if (!roleStartsWeb(role)) {
    logCore("info", "application.started", { role });
    await waitForRuntimeShutdown(role, runtime.close.bind(runtime));
    return;
  }

  const { AppModule } = await import("./app.module.js");
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    rawBody: true,
  });
  const webConfiguration = configurations.find((configuration) => configuration.profile === "web")!;
  const bodyLimit = webConfiguration.http!.bodyLimit;
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

  const port = webConfiguration.http!.port;
  await app.listen(port);

  logCore("info", "application.listening", { role, port });
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
        try {
          beginHttpShutdown();
          await closeRuntime();
          beginModelShutdown();
          await drainModelRequests();
        } finally {
          await shutdownAgentObservability();
        }
        logCore("info", "application.stopped", { role, signal });
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    process.once("SIGINT", () => { void shutdown("SIGINT"); });
    process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  });
}

function captureRawBody(
  request: RawBodyRequest,
  _response: unknown,
  buffer: Buffer,
): void {
  request.rawBody = buffer;
}

bootstrap().catch(async (error) => {
  await runtimeComposition().close().catch(() => undefined);
  await shutdownAgentObservability();
  logCore("error", "application.bootstrap_failed", { error });
  process.exitCode = 1;
});
