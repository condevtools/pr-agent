import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationShutdownSequence } from "../../src/bootstrap/shutdown-coordinator.service.js";

test("shutdown quiesces background work before HTTP disposal and closes transports after it", async () => {
  const events: string[] = [];
  const sequence = new ApplicationShutdownSequence({
    beginHttpShutdown: () => { events.push("http-intake-stopped"); },
    quiesceRuntime: async () => { events.push("background-drained"); },
    quiesceGitHubOnboarding: async () => { events.push("github-sync-drained"); },
    closeApplicationResources: async () => { events.push("web-resources-closed"); },
    closeGitHubOnboardingResources: async () => { events.push("github-sync-resources-closed"); },
    beginModelShutdown: () => { events.push("model-intake-stopped"); },
    drainModelRequests: async () => { events.push("model-drained"); return true; },
    closeObservability: async () => { events.push("observability-closed"); },
  });

  await Promise.all([
    sequence.beforeApplicationShutdown(),
    sequence.beforeApplicationShutdown(),
  ]);
  events.push("http-disposed");
  assert.equal(await sequence.onApplicationShutdown(), true);
  assert.equal(await sequence.onApplicationShutdown(), true);

  assert.deepEqual(events, [
    "http-intake-stopped",
    "background-drained",
    "github-sync-drained",
    "http-disposed",
    "web-resources-closed",
    "github-sync-resources-closed",
    "model-intake-stopped",
    "model-drained",
    "observability-closed",
  ]);
});

test("telemetry closure runs after a resource failure and never replaces the shutdown error", async () => {
  const failure = new Error("resource failure");
  let closed = 0;
  const sequence = new ApplicationShutdownSequence({
    beginHttpShutdown: () => undefined,
    quiesceRuntime: async () => undefined,
    quiesceGitHubOnboarding: async () => undefined,
    closeApplicationResources: async () => { throw failure; },
    closeGitHubOnboardingResources: async () => undefined,
    beginModelShutdown: () => undefined,
    drainModelRequests: async () => true,
    closeObservability: async () => { closed += 1; throw new Error("exporter failure"); },
  });
  await assert.rejects(sequence.onApplicationShutdown(), failure);
  await assert.rejects(sequence.onApplicationShutdown(), failure);
  assert.equal(closed, 1);
});

test("shutdown still drains onboarding when another runtime phase fails", async () => {
  const events: string[] = [];
  const failure = new Error("runtime stop failed");
  const sequence = new ApplicationShutdownSequence({
    beginHttpShutdown: () => { events.push("http-intake-stopped"); },
    quiesceRuntime: async () => { events.push("runtime-failed"); throw failure; },
    quiesceGitHubOnboarding: async () => { events.push("github-sync-drained"); },
    closeApplicationResources: async () => { events.push("unexpected-close"); },
    closeGitHubOnboardingResources: async () => { events.push("unexpected-onboarding-close"); },
    beginModelShutdown: () => { events.push("unexpected-model-stop"); },
    drainModelRequests: async () => true,
  });

  await assert.rejects(sequence.beforeApplicationShutdown(), failure);
  assert.deepEqual(events, ["http-intake-stopped", "runtime-failed", "github-sync-drained"]);
});
