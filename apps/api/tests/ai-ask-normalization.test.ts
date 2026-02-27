import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAskResultForSchema } from "@mr-agent/review/ai-result-normalization.ts";
import { parseJsonFromModelText } from "@mr-agent/review/ai-provider-json.ts";

test("normalizeAskResultForSchema extracts trailing JSON answer from mixed text", () => {
  const mixed = [
    "Preparing fix suggestions",
    "Adjusting tool call to shell",
    "{\"command\":[\"bash\",\"-lc\",\"ls\"],\"workdir\":\".\"}",
    "Providing JSON-formatted fix suggestions",
    "{\"answer\":\"可以，给你一套可落地的修复建议：先修模板，再补守卫。\"}",
  ].join("\n");

  const result = normalizeAskResultForSchema(mixed);
  assert.equal(result.answer, "可以，给你一套可落地的修复建议：先修模板，再补守卫。");
});

test("parseJsonFromModelText extracts last JSON object from mixed thinking + tool call output", () => {
  const mixed = [
    "Preparing fix suggestions",
    "Adjusting tool call to shell",
    '{"command":["bash","-lc","ls"],"workdir":"."}',
    "Providing JSON-formatted fix suggestions",
    '{"answer":"可以，给你一套建议。"}',
  ].join("\n");

  const result = parseJsonFromModelText(mixed) as { answer: string };
  assert.equal(result.answer, "可以，给你一套建议。");
});

test("parseJsonFromModelText handles clean JSON without regression", () => {
  const clean = '{"answer":"hello"}';
  const result = parseJsonFromModelText(clean) as { answer: string };
  assert.equal(result.answer, "hello");
});

test("parseJsonFromModelText handles fenced code block JSON", () => {
  const fenced = 'Some text\n```json\n{"answer":"fenced"}\n```\nmore text';
  const result = parseJsonFromModelText(fenced) as { answer: string };
  assert.equal(result.answer, "fenced");
});

test("parseJsonFromModelText handles single JSON with leading text", () => {
  const leading = 'thinking...\n{"answer":"extracted"}';
  const result = parseJsonFromModelText(leading) as { answer: string };
  assert.equal(result.answer, "extracted");
});
