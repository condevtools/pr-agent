import "reflect-metadata";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { NestFactory } from "@nestjs/core";
import * as sourceRuntime from "../src/agent-runtime/versions.ts";
import * as builtRuntime from "../dist/agent-runtime/versions.js";

const sourceManifest = await sourceRuntime.buildCodeManifest(new URL("../src/", import.meta.url));
const builtManifest = JSON.parse(await readFile(new URL("../dist/agent-runtime/runtime-manifest.json", import.meta.url), "utf8"));
assert.deepEqual(builtManifest, sourceManifest, "Built manifest must cover the current full source tree");
assert.deepEqual(await builtRuntime.runtimeVersionManifest({ fixture: "build-smoke" }),
  await sourceRuntime.runtimeVersionManifest({ fixture: "build-smoke" }));
await import("#core");
await import("#review");
await import("#model");
await access(new URL("../dist/main.js", import.meta.url));
await access(new URL("../dist/agent-runtime/postgres/migrations/020_release_control.sql", import.meta.url));
for (const retired of ["harness", "agents", "modules", "common", "testing",
  "integrations/shared", "integrations/notify"]) {
  await assert.rejects(access(new URL(`../dist/${retired}/`, import.meta.url)), { code: "ENOENT" });
}

// Exercise built Nest composition without enabling Probot, listening on a port,
// loading .env, connecting to PostgreSQL, or dispatching background jobs.
delete process.env.APP_ID;
const { AppModule } = await import("../dist/app.module.js");
const app = await NestFactory.create(AppModule, { logger: false });
try { await app.init(); } finally { await app.close(); }
console.log("PASS built aliases, Nest composition, assets, and source/build runtime manifests");
