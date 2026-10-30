import assert from "node:assert/strict";
import test from "node:test";
import { GithubWebhookController } from "../../src/http/webhooks/github/github-webhook.controller.js";
import { GitlabWebhookController } from "../../src/http/webhooks/gitlab/gitlab-webhook.controller.js";

test("public deep health never calls a provider or requires Worker model credentials", async () => {
  const previous = { ...process.env }, originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("public health must not make requests"); };
  try {
    for (const key of ["OPENAI_API_KEY", "OPENAI_COMPATIBLE_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"]) {
      delete process.env[key];
    }
    process.env.GITHUB_WEBHOOK_SECRET = "local-health-fixture";
    process.env.GITLAB_WEBHOOK_SECRET = "local-health-fixture";
    process.env.HEALTHCHECK_AI_LIVE_PROBE = "true"; // Old flag cannot reopen public probes.
    for (const controller of [new GithubWebhookController(undefined as never, undefined as never),
      new GitlabWebhookController(undefined as never, undefined as never)]) {
      const result = await controller.health("1");
      assert.equal(result.ok, true);
      assert.equal(result.checks?.webhook?.configured, true);
      assert.equal("ai" in (result.checks ?? {}), false);
    }
    delete process.env.GITLAB_WEBHOOK_SECRET;
    const missing = await new GitlabWebhookController(undefined as never, undefined as never).health("deep");
    assert.equal(missing.ok, false);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
