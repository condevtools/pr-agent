import assert from "node:assert/strict";
import test from "node:test";

import {
  BadWebhookRequestError,
  WebhookAuthError,
  ensureError,
} from "@mr-agent/core/errors.ts";

test("ensureError preserves original value via cause for non-Error inputs", () => {
  const source = { reason: "boom" };
  const err = ensureError(source);
  assert.equal(err.message, "[object Object]");
  assert.equal((err as Error & { cause?: unknown }).cause, source);
});

test("custom webhook errors keep prototype chain intact", () => {
  const auth = new WebhookAuthError("invalid token");
  const badRequest = new BadWebhookRequestError("bad body");

  assert.equal(auth instanceof WebhookAuthError, true);
  assert.equal(badRequest instanceof BadWebhookRequestError, true);
});
