import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { BadWebhookRequestError } from "../../../src/core/index.js";
import { handleGitHubOnboardingLifecycle } from "../../../src/integrations/github/onboarding/lifecycle.js";
import { handleGitHubWebhookEvent, handlePlainGitHubWebhook } from "../../../src/integrations/github/webhooks/handler.js";

const baseEnvironment = {
  FEATURE_GITHUB_ONBOARDING: "on",
  APP_ID: "71",
  GITHUB_API_URL: "https://api.github.com",
};

test("restrictive installation lifecycle events revoke access and preserve delivery idempotency keys", async () => {
  const calls: unknown[] = [];
  const dependencies = fakeDependencies(calls);
  for (const [action, reason] of [["deleted", "deleted"], ["suspend", "suspended"]] as const) {
    const result = await handleGitHubOnboardingLifecycle({
      eventName: "installation", payload: payload(action), deliveryId: `delivery-${action}`, env: baseEnvironment,
    }, dependencies);
    assert.match(result?.message ?? "", /restriction applied/u);
    assert.deepEqual(calls.pop(), {
      appId: 71, installationId: 81, state: "revoked",
      reason: `GitHub App installation ${reason}`, deliveryId: `delivery-${action}`,
    });
  }
});

test("repository removals are scoped, while an empty removal inventory restricts the whole installation", async () => {
  const calls: unknown[] = [];
  const dependencies = fakeDependencies(calls);
  await handleGitHubOnboardingLifecycle({
    eventName: "installation_repositories",
    payload: { ...payload("removed"), repositories_removed: [{ id: 91 }, { id: 91 }, { id: 92 }] },
    deliveryId: "delivery-selected", env: baseEnvironment,
  }, dependencies);
  await handleGitHubOnboardingLifecycle({
    eventName: "installation_repositories",
    payload: { ...payload("removed"), repositories_removed: [] },
    deliveryId: "delivery-all-to-selected", env: baseEnvironment,
  }, dependencies);
  assert.deepEqual(calls, [{
    appId: 71, installationId: 81, repositoryIds: [91, 92], state: "revoked",
    reason: "GitHub App repository access removed", deliveryId: "delivery-selected",
  }, {
    appId: 71, installationId: 81, state: "unknown",
    reason: "GitHub App repository selection requires reconciliation", deliveryId: "delivery-all-to-selected",
  }]);
});

test("positive lifecycle events never restore access and disabled onboarding never opens its pool", async () => {
  const calls: unknown[] = [];
  const dependencies = fakeDependencies(calls);
  for (const [eventName, action] of [["installation", "created"], ["installation", "unsuspend"],
    ["installation_repositories", "added"]] as const) {
    const result = await handleGitHubOnboardingLifecycle({
      eventName, payload: { ...payload(action), repositories_removed: [] },
      deliveryId: `delivery-${action}`, env: baseEnvironment,
    }, dependencies);
    assert.match(result?.message ?? "", /ignored/u);
  }
  assert.deepEqual(calls, []);
  const disabled = await handleGitHubOnboardingLifecycle({
    eventName: "installation", payload: "not parsed", env: { FEATURE_GITHUB_ONBOARDING: "off" },
  }, { getStore: async () => { throw new Error("pool must stay closed"); } });
  assert.match(disabled?.message ?? "", /disabled/u);
});

test("lifecycle identity, delivery and removed inventory fail closed", async () => {
  const dependencies = fakeDependencies([]);
  await assert.rejects(handleGitHubOnboardingLifecycle({
    eventName: "installation", payload: { ...payload("deleted"), installation: { id: 81, app_id: 72 } },
    deliveryId: "delivery-wrong-app", env: baseEnvironment,
  }, dependencies), BadWebhookRequestError);
  await assert.rejects(handleGitHubOnboardingLifecycle({
    eventName: "installation", payload: payload("deleted"), deliveryId: "bad delivery", env: baseEnvironment,
  }, dependencies), BadWebhookRequestError);
  await assert.rejects(handleGitHubOnboardingLifecycle({
    eventName: "installation_repositories", payload: payload("removed"),
    deliveryId: "delivery-missing-inventory", env: baseEnvironment,
  }, dependencies), BadWebhookRequestError);
});

test("plain and Probot-style verified dispatch share the disabled lifecycle path", async () => {
  const previousFeature = process.env.FEATURE_GITHUB_ONBOARDING;
  const previousSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const previousToken = process.env.GITHUB_WEBHOOK_TOKEN;
  process.env.FEATURE_GITHUB_ONBOARDING = "off";
  process.env.GITHUB_WEBHOOK_SECRET = "lifecycle-secret";
  delete process.env.GITHUB_WEBHOOK_TOKEN;
  try {
    const body = JSON.stringify(payload("deleted"));
    const plain = await handlePlainGitHubWebhook({
      payload: payload("deleted"), rawBody: body,
      headers: { "x-github-event": "installation", "x-github-delivery": "delivery-plain",
        "x-hub-signature-256": `sha256=${createHmac("sha256", "lifecycle-secret").update(body).digest("hex")}` },
      logger: logger(),
    });
    const app = await handleGitHubWebhookEvent({
      eventName: "installation", payload: payload("deleted"), deliveryId: "delivery-app",
      octokit: {} as never, logger: logger(), runtimeMode: "github-app",
    });
    assert.equal(plain.message, app.message);
    assert.match(plain.message, /disabled/u);
  } finally {
    if (previousFeature === undefined) delete process.env.FEATURE_GITHUB_ONBOARDING;
    else process.env.FEATURE_GITHUB_ONBOARDING = previousFeature;
    if (previousSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = previousSecret;
    if (previousToken === undefined) delete process.env.GITHUB_WEBHOOK_TOKEN;
    else process.env.GITHUB_WEBHOOK_TOKEN = previousToken;
  }
});

test("trusted replay cannot apply a lifecycle database mutation", async () => {
  const previousFeature = process.env.FEATURE_GITHUB_ONBOARDING;
  const previousApp = process.env.APP_ID;
  process.env.FEATURE_GITHUB_ONBOARDING = "on";
  process.env.APP_ID = "71";
  try {
    const result = await handlePlainGitHubWebhook({
      payload: payload("deleted"), rawBody: JSON.stringify(payload("deleted")),
      headers: { "x-github-event": "installation", "x-github-delivery": "delivery-replay" },
      logger: logger(), skipSignatureVerification: true, allowLifecycleMutation: false,
    });
    assert.match(result.message, /ignored.*replay/u);
  } finally {
    if (previousFeature === undefined) delete process.env.FEATURE_GITHUB_ONBOARDING;
    else process.env.FEATURE_GITHUB_ONBOARDING = previousFeature;
    if (previousApp === undefined) delete process.env.APP_ID;
    else process.env.APP_ID = previousApp;
  }
});

function payload(action: string) {
  return { action, installation: { id: 81, app_id: 71 } };
}

function fakeDependencies(calls: unknown[]) {
  return { getStore: async () => ({ invalidate: async (input: unknown) => { calls.push(input); return 1; } }) };
}

function logger() {
  return { info: () => undefined, error: () => undefined };
}
