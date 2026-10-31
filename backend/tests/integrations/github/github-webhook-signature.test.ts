import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { WebhookAuthError } from "../../../src/core/index.js";
import { PublicationWriteBoundaryError } from "../../../src/agent-runtime/authority/write-boundary.js";
import { guardGitHubOctokit } from "../../../src/integrations/github/api/http-client.js";
import { createLazyGitHubInstallationOctokit,
  GithubWebhookService } from "../../../src/http/webhooks/github/github-webhook.service.js";
import { verifyWebhookSignature } from "../../../src/integrations/github/webhooks/handler.js";

test("mixed webhook secrets classify App and plain live deliveries without authority crossover", () => {
  withEnvironment({ APP_ID: "7", PRIVATE_KEY: "fixture-key", WEBHOOK_SECRET: "app-secret",
    GITHUB_WEBHOOK_SECRET: "plain-secret", GITHUB_WEBHOOK_SKIP_SIGNATURE: undefined }, () => {
    const body = JSON.stringify({ action: "opened", installation: { id: 31 } });
    assert.equal(verifyWebhookSignature(body, headers("pull_request", body, "app-secret")), "app");
    assert.equal(verifyWebhookSignature(body, headers("pull_request", body, "plain-secret")), "plain");
    assert.equal(verifyWebhookSignature(body, headers("installation", body, "app-secret")), "app");
    assert.throws(() => verifyWebhookSignature(body, headers("installation", body, "plain-secret")),
      WebhookAuthError, "a repository webhook secret cannot authorize lifecycle mutation");
  });
});

test("signature skip and legacy single-secret plain mode never acquire App authority", () => {
  const body = JSON.stringify({ action: "opened", installation: { id: 31 } });
  withEnvironment({ NODE_ENV: "test", APP_ID: undefined, PRIVATE_KEY: undefined,
    WEBHOOK_SECRET: "legacy-secret", GITHUB_WEBHOOK_SECRET: undefined,
    GITHUB_WEBHOOK_SKIP_SIGNATURE: undefined }, () => {
    assert.equal(verifyWebhookSignature(body, headers("pull_request", body, "legacy-secret")), "plain");
  });
  withEnvironment({ NODE_ENV: "test", APP_ID: "7", PRIVATE_KEY: "fixture-key",
    WEBHOOK_SECRET: "app-secret", GITHUB_WEBHOOK_SECRET: "plain-secret",
    GITHUB_WEBHOOK_SKIP_SIGNATURE: "true" }, () => {
    assert.equal(verifyWebhookSignature(body, { "x-github-event": "pull_request" }), "plain");
  });
});

test("plain-signed lifecycle and trusted replay cannot mutate App installation state", async () => {
  const payload = { action: "created", installation: { id: 31, app_id: 7, account: { id: 501 } } };
  const body = JSON.stringify(payload);
  await withEnvironmentAsync({ APP_ID: "7", PRIVATE_KEY: "fixture-key", WEBHOOK_SECRET: "app-secret",
    GITHUB_WEBHOOK_SECRET: "plain-secret", FEATURE_GITHUB_ONBOARDING: "on" }, async () => {
    const service = new GithubWebhookService();
    await assert.rejects(service.handleTrigger({ payload, rawBody: body,
      headers: { ...headers("installation", body, "plain-secret"), "x-github-delivery": "plain-lifecycle" } }),
    WebhookAuthError);
    const replay = await service.handleTrigger({ payload, rawBody: body, trustReplay: true,
      headers: { "x-github-event": "installation", "x-github-delivery": "trusted-replay" } });
    assert.match(replay.message, /ignored.*replay/u);
  });
});

test("lazy installation client exposes resource groups, defers reads, and preserves the write boundary", async () => {
  let loads = 0;
  let writes = 0;
  const fixture = {
    pulls: { get: async function () { return { data: { number: 3, owner: this === fixture.pulls } }; } },
    issues: { createComment: async () => { writes += 1; return { data: { id: 1 } }; } },
  };
  const client = guardGitHubOctokit(createLazyGitHubInstallationOctokit({ installation: { id: 31 } },
    async (installationId) => {
      loads += 1;
      assert.equal(installationId, 31);
      return fixture;
    }));

  assert.equal(typeof client.pulls, "object");
  assert.equal(loads, 0);
  const result = await client.pulls.get({ owner: "example", repo: "project", pull_number: 3 });
  assert.equal(result.data.number, 3);
  assert.equal((result.data as { owner?: boolean }).owner, true);
  assert.equal(loads, 1);
  assert.throws(() => client.issues.createComment({ owner: "example", repo: "project", issue_number: 3,
    body: "blocked" }), PublicationWriteBoundaryError);
  assert.equal(writes, 0);
});

function headers(event: string, body: string, secret: string) {
  return { "x-github-event": event,
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` };
}

function withEnvironment(values: Record<string, string | undefined>, callback: () => void): void {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

async function withEnvironmentAsync(values: Record<string, string | undefined>,
  callback: () => Promise<void>): Promise<void> {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}
