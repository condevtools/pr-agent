import assert from "node:assert/strict";
import test from "node:test";

import { GitHubInstallationReconcilerLifecycle, shouldStartGitHubInstallationReconciler } from
  "../../src/agent-runtime/runtime/github-onboarding.js";

const appEnvironment = { APP_ID: "123", PRIVATE_KEY: "private-key", WEBHOOK_SECRET: "webhook-secret" };

test("only web/all complete App roles start reconciliation, including cleanup-only off mode", () => {
  assert.equal(shouldStartGitHubInstallationReconciler(appEnvironment, "web"), true);
  assert.equal(shouldStartGitHubInstallationReconciler({ ...appEnvironment,
    FEATURE_GITHUB_ONBOARDING: "off" }, "all"), true);
  assert.equal(shouldStartGitHubInstallationReconciler(appEnvironment, "worker"), false);
  assert.equal(shouldStartGitHubInstallationReconciler(appEnvironment, "recovery"), false);
  assert.equal(shouldStartGitHubInstallationReconciler({ GITHUB_TOKEN: "pat" }, "web"), false);
});

test("installation reconciler lifecycle initializes once, reports state, and drains on stop", async () => {
  const events: string[] = [];
  const target = {
    running: false,
    start() { this.running = true; events.push("started"); },
    async stop() { events.push("stopping"); this.running = false; events.push("stopped"); },
    readiness() { return { running: this.running }; },
  };
  const lifecycle = new GitHubInstallationReconcilerLifecycle({
    shouldStart: () => true,
    create: async () => { events.push("role-and-schema-ready"); return target; },
  });

  await Promise.all([lifecycle.start(), lifecycle.start()]);
  assert.deepEqual(events, ["role-and-schema-ready", "started"]);
  assert.deepEqual(lifecycle.status(), { running: true });
  await lifecycle.stop();
  assert.deepEqual(events, ["role-and-schema-ready", "started", "stopping", "stopped"]);
  assert.deepEqual(lifecycle.status(), { running: false });
  await lifecycle.stop();
  assert.equal(events.filter((event) => event === "stopping").length, 1);
});

test("installation reconciler lifecycle is a no-op outside complete web App mode", async () => {
  let creates = 0;
  const lifecycle = new GitHubInstallationReconcilerLifecycle({
    shouldStart: () => false,
    create: async () => {
      creates += 1;
      return { start() {}, async stop() {}, readiness: () => ({ running: true }) };
    },
  });
  await lifecycle.start();
  assert.equal(creates, 0);
  assert.deepEqual(lifecycle.status(), { running: false });
});

test("shutdown waits for in-flight role initialization before draining the reconciler", async () => {
  let release!: () => void;
  const initialized = new Promise<void>((resolve) => { release = resolve; });
  const events: string[] = [];
  const lifecycle = new GitHubInstallationReconcilerLifecycle({
    shouldStart: () => true,
    create: async () => {
      events.push("initializing");
      await initialized;
      return {
        start: () => { events.push("started"); },
        stop: async () => { events.push("stopped"); },
        readiness: () => ({ running: true }),
      };
    },
  });
  const starting = lifecycle.start();
  const stopping = lifecycle.stop();
  await Promise.resolve();
  assert.deepEqual(events, ["initializing"]);
  release();
  await Promise.all([starting, stopping]);
  assert.deepEqual(events, ["initializing", "started", "stopped"]);
});
