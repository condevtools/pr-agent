import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationShutdownSequence } from "../../src/bootstrap/shutdown-coordinator.service.js";

test("shutdown quiesces background work before HTTP disposal and closes transports after it", async () => {
  const events: string[] = [];
  const sequence = new ApplicationShutdownSequence({
    beginHttpShutdown: () => { events.push("http-intake-stopped"); },
    quiesceRuntime: async () => { events.push("background-drained"); },
    closeApplicationResources: async () => { events.push("web-resources-closed"); },
    beginModelShutdown: () => { events.push("model-intake-stopped"); },
    drainModelRequests: async () => { events.push("model-drained"); return true; },
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
    "http-disposed",
    "web-resources-closed",
    "model-intake-stopped",
    "model-drained",
  ]);
});
