import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { GithubWebhookController } from "../src/modules/github/github.webhook.controller.ts";
import { GitlabWebhookController } from "../src/modules/gitlab/gitlab.webhook.controller.ts";
import {
  flushWebhookStoreWrites,
  listStoredWebhookEvents,
} from "../src/modules/webhook/webhook-replay.ts";
import {
  incrementMetricCounter,
  renderPrometheusMetrics,
} from "../src/modules/webhook/metrics-runtime.ts";
import { clearMetricState } from "../src/testing/metrics-test-api.ts";

function buildStorePath(label: string): string {
  return join(
    "/tmp",
    `pr-agent-webhook-events-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.ndjson`,
  );
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("webhook event replay store records successful trigger asynchronously", async () => {
  const storeFile = buildStorePath("success");
  const originalStoreEnabled = process.env.WEBHOOK_EVENT_STORE_ENABLED;
  const originalStoreFile = process.env.WEBHOOK_EVENT_STORE_FILE;
  const originalSampleRate = process.env.WEBHOOK_EVENT_STORE_SAMPLE_RATE;
  process.env.WEBHOOK_EVENT_STORE_ENABLED = "true";
  process.env.WEBHOOK_EVENT_STORE_FILE = storeFile;
  process.env.WEBHOOK_EVENT_STORE_SAMPLE_RATE = "1";

  const controller = new GithubWebhookController({
    handleTrigger: async () => ({ ok: true, message: "ok" }),
  } as never);

  try {
    await controller.trigger(
      {
        body: { action: "opened" },
        rawBody: "{\"action\":\"opened\"}",
      } as never,
      {
        "x-github-event": "issues",
      },
    );

    await waitFor(async () => {
      const current = await listStoredWebhookEvents({
        platform: "github",
        limit: 5,
      });
      return current.length === 1;
    });
    const listed = await listStoredWebhookEvents({
      platform: "github",
      limit: 5,
    });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.eventName, "issues");
  } finally {
    process.env.WEBHOOK_EVENT_STORE_ENABLED = originalStoreEnabled;
    process.env.WEBHOOK_EVENT_STORE_FILE = originalStoreFile;
    process.env.WEBHOOK_EVENT_STORE_SAMPLE_RATE = originalSampleRate;
    rmSync(storeFile, { force: true });
  }
});

test("webhook event replay store does not record failed trigger request", async () => {
  const storeFile = buildStorePath("failure");
  const originalStoreEnabled = process.env.WEBHOOK_EVENT_STORE_ENABLED;
  const originalStoreFile = process.env.WEBHOOK_EVENT_STORE_FILE;
  const originalSampleRate = process.env.WEBHOOK_EVENT_STORE_SAMPLE_RATE;
  process.env.WEBHOOK_EVENT_STORE_ENABLED = "true";
  process.env.WEBHOOK_EVENT_STORE_FILE = storeFile;
  process.env.WEBHOOK_EVENT_STORE_SAMPLE_RATE = "1";

  const controller = new GithubWebhookController({
    handleTrigger: async () => {
      throw new Error("boom");
    },
  } as never);

  try {
    await assert.rejects(
      () =>
        controller.trigger(
          {
            body: { action: "opened" },
            rawBody: "{\"action\":\"opened\"}",
          } as never,
          {
            "x-github-event": "issues",
          },
        ),
      /boom/i,
    );

    await flushWebhookStoreWrites();
    const listed = await listStoredWebhookEvents({
      platform: "github",
      limit: 5,
    });
    assert.equal(listed.length, 0);
  } finally {
    process.env.WEBHOOK_EVENT_STORE_ENABLED = originalStoreEnabled;
    process.env.WEBHOOK_EVENT_STORE_FILE = originalStoreFile;
    process.env.WEBHOOK_EVENT_STORE_SAMPLE_RATE = originalSampleRate;
    rmSync(storeFile, { force: true });
  }
});

test("webhook request metrics collapse unknown event labels to other", async () => {
  clearMetricState();

  const githubController = new GithubWebhookController({
    handleTrigger: async () => ({ ok: true, message: "ok" }),
  } as never);
  const gitlabController = new GitlabWebhookController({
    handleTrigger: async () => ({ ok: true, message: "ok" }),
  } as never);

  await githubController.trigger(
    {
      body: {},
      rawBody: "{}",
    } as never,
    {
      "x-github-event": "custom-event-name-123",
    },
  );
  await gitlabController.trigger(
    {
      body: {
        project: {
          id: 1,
          name: "demo",
          web_url: "https://gitlab.example.com/acme/demo",
        },
        object_attributes: {},
      },
    } as never,
    {
      "x-gitlab-event": "totally-random-hook",
    },
  );

  const metrics = renderPrometheusMetrics();
  assert.match(
    metrics,
    /pr_agent_webhook_requests_total\{event="other",platform="github"\} 1/,
  );
  assert.match(
    metrics,
    /pr_agent_webhook_requests_total\{event="other",platform="gitlab"\} 1/,
  );
});

test("webhook replay sample rate=0 drops debug event recording", async () => {
  const storeFile = buildStorePath("sample0");
  const originalStoreEnabled = process.env.WEBHOOK_EVENT_STORE_ENABLED;
  const originalStoreFile = process.env.WEBHOOK_EVENT_STORE_FILE;
  const originalSampleRate = process.env.WEBHOOK_EVENT_STORE_SAMPLE_RATE;
  process.env.WEBHOOK_EVENT_STORE_ENABLED = "true";
  process.env.WEBHOOK_EVENT_STORE_FILE = storeFile;
  process.env.WEBHOOK_EVENT_STORE_SAMPLE_RATE = "0";

  const controller = new GithubWebhookController({
    handleTrigger: async () => ({ ok: true, message: "ok" }),
  } as never);

  try {
    await controller.trigger(
      {
        body: { action: "opened" },
        rawBody: "{\"action\":\"opened\"}",
      } as never,
      {
        "x-github-event": "issues",
      },
    );
    await flushWebhookStoreWrites();
    const listed = await listStoredWebhookEvents({
      platform: "github",
      limit: 5,
    });
    assert.equal(listed.length, 0);
  } finally {
    process.env.WEBHOOK_EVENT_STORE_ENABLED = originalStoreEnabled;
    process.env.WEBHOOK_EVENT_STORE_FILE = originalStoreFile;
    process.env.WEBHOOK_EVENT_STORE_SAMPLE_RATE = originalSampleRate;
    rmSync(storeFile, { force: true });
  }
});

test("metrics counter store caps cardinality to avoid unbounded memory growth", () => {
  const originalLimit = process.env.MAX_METRIC_COUNTER_RECORDS;
  process.env.MAX_METRIC_COUNTER_RECORDS = "100";

  try {
    clearMetricState();
    for (let index = 0; index < 101; index += 1) {
      incrementMetricCounter("pr_agent_webhook_requests_total", {
        platform: "github",
        event: `e${index}`,
      });
    }

    const rendered = renderPrometheusMetrics();
    assert.doesNotMatch(
      rendered,
      /pr_agent_webhook_requests_total\{event="e0",platform="github"\}/,
    );
    assert.match(
      rendered,
      /pr_agent_webhook_requests_total\{event="e1",platform="github"\} 1/,
    );
    assert.match(
      rendered,
      /pr_agent_webhook_requests_total\{event="e100",platform="github"\} 1/,
    );
  } finally {
    process.env.MAX_METRIC_COUNTER_RECORDS = originalLimit;
  }
});
