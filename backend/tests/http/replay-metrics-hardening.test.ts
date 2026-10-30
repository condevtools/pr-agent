import assert from "node:assert/strict";
import test from "node:test";

import { GitlabWebhookController } from "../../src/http/webhooks/gitlab/gitlab-webhook.controller.ts";
import { runVerifiedGitHubIntake } from "../../src/http/webhooks/github/verified-github-intake.ts";
import {
  incrementMetricCounter,
  renderPrometheusMetrics,
} from "../../src/http/system/metrics-runtime.ts";
import { clearMetricState } from "../support/metrics-test-api.ts";


test("webhook request metrics collapse unknown event labels to other", async () => {
  clearMetricState();

  const gitlabController = new GitlabWebhookController({
    handleTrigger: async () => ({ ok: true, message: "ok" }),
  } as never);

  await runVerifiedGitHubIntake({ eventName: "custom-event-name-123", payload: {},
    execute: async () => ({ ok: true, message: "ok" }) });
  await gitlabController.trigger(
    {
      body: {},
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
