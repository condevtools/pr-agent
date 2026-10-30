import assert from "node:assert/strict";
import test from "node:test";

import { reviewPartialNoFilesMessage } from "../../src/review/rendering/messages.js";

test("zero-file partial coverage never claims that there were no reviewable changes", () => {
  const message = reviewPartialNoFilesMessage(
    ["artifact_output_limit", "provider_file_limit", "artifact_output_limit", "unsafe reason"], "en");
  assert.match(message, /could not retain coverage for any file/i);
  assert.match(message, /artifact_output_limit, provider_file_limit/);
  assert.doesNotMatch(message, /no textual changes|unsafe reason/i);
});
