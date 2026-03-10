import assert from "node:assert/strict";
import test from "node:test";

import { createRestBackedOctokit } from "../src/integrations/github/github-webhook.ts";

test("rest octokit throws when JSON response is unexpectedly empty", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/contents/")) {
      return new Response(null, { status: 204 });
    }
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const octokit = createRestBackedOctokit({
      token: "token",
      baseUrl: "https://api.github.com",
    });
    await assert.rejects(
      () =>
        octokit.repos.getContent({
          owner: "acme",
          repo: "demo",
          path: "README.md",
        }),
      /expected json body/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
