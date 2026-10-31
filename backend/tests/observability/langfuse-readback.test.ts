import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { verifyLangfuseTrace } from "../../scripts/langfuse-readback.js";

test("authenticated readback verifies the complete synthetic Agent tree", async () => {
  const traceId = "a".repeat(32);
  let requestedPath = "";
  let authenticated = false;
  const fixture = await fixtureServer((request, response) => {
    requestedPath = request.url ?? "";
    authenticated = request.headers.authorization === `Basic ${Buffer.from("fixture-public:fixture-secret").toString("base64")}`;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: validRows(traceId) }));
  });
  try {
    const result = await verifyLangfuseTrace({
      baseUrl: ` ${fixture.origin} `, publicKey: " fixture-public ", secretKey: " fixture-secret ",
      traceId, serverVersion: "3.225.5", deadlineMs: 3_000, pollMs: 5,
    });
    assert.deepEqual(result, { verified: true, observations: 26, checkpointObservations: 10 });
    assert.equal(authenticated, true);
    assert.match(requestedPath, /^\/api\/public\/observations\?/u);
    assert.match(requestedPath, new RegExp(`traceId=${traceId}`, "u"));
  } finally { await fixture.close(); }
});

test("authenticated readback rejects invalid project keys without polling", async () => {
  let requests = 0;
  const fixture = await fixtureServer((_request, response) => {
    requests += 1;
    response.writeHead(401).end();
  });
  try {
    await assert.rejects(
      verifyLangfuseTrace({
        baseUrl: fixture.origin, publicKey: "wrong", secretKey: "wrong",
        traceId: "b".repeat(32), serverVersion: "3.225.5", deadlineMs: 3_000, pollMs: 5,
      }),
      { name: "LangfuseReadbackUnauthorizedError" },
    );
    assert.equal(requests, 1);
  } finally { await fixture.close(); }
});

test("authenticated readback times out while observations are incomplete", async () => {
  const traceId = "c".repeat(32);
  let requests = 0;
  const fixture = await fixtureServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: validRows(traceId).slice(0, 15) }));
  });
  try {
    await assert.rejects(
      verifyLangfuseTrace({
        baseUrl: fixture.origin, publicKey: "fixture-public", secretKey: "fixture-secret",
        traceId, serverVersion: "3.225.5", deadlineMs: 500, pollMs: 5,
      }),
      { name: "LangfuseReadbackTimeoutError" },
    );
    assert.ok(requests >= 1);
  } finally { await fixture.close(); }
});

test("v4 readback requests model and explicit usage/cost fields", async () => {
  const traceId = "d".repeat(32);
  let requestedUrl: URL | undefined;
  const fixture = await fixtureServer((request, response) => {
    requestedUrl = new URL(request.url!, "http://fixture");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: validRows(traceId) }));
  });
  try {
    await verifyLangfuseTrace({
      baseUrl: fixture.origin, publicKey: "fixture-public", secretKey: "fixture-secret",
      traceId, serverVersion: "4.0.0", deadlineMs: 3_000,
    });
    assert.equal(requestedUrl?.pathname, "/api/public/v2/observations");
    assert.equal(requestedUrl?.searchParams.get("fields"), "core,basic,model,usage");
  } finally { await fixture.close(); }
});

test("readback requires the exported fixture cost rather than an inferred price", async () => {
  const traceId = "e".repeat(32);
  const fixture = await fixtureServer((_request, response) => {
    const rows = validRows(traceId).map((row) => row.type === "GENERATION"
      ? { ...row, costDetails: {}, calculatedTotalCost: 0.000028 } : row);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: rows }));
  });
  try {
    await assert.rejects(verifyLangfuseTrace({
      baseUrl: fixture.origin, publicKey: "fixture-public", secretKey: "fixture-secret",
      traceId, serverVersion: "3.225.5", deadlineMs: 500, pollMs: 5,
    }), { name: "LangfuseReadbackTimeoutError" });
  } finally { await fixture.close(); }
});

test("readback rejects checkpoint observations that expose recovery state", async () => {
  const traceId = "f".repeat(32);
  const fixture = await fixtureServer((_request, response) => {
    const rows = validRows(traceId).map((row) => row.name === "save-checkpoint"
      ? { ...row, metadata: { ...(row.metadata as Record<string, unknown>),
        checkpointState: { fixtureMarker: "synthetic-checkpoint-state-must-not-export" } } }
      : row);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: rows }));
  });
  try {
    await assert.rejects(verifyLangfuseTrace({
      baseUrl: fixture.origin, publicKey: "fixture-public", secretKey: "fixture-secret",
      traceId, serverVersion: "3.225.5", deadlineMs: 500, pollMs: 5,
    }), { name: "LangfuseReadbackTimeoutError" });
  } finally { await fixture.close(); }
});

function validRows(traceId: string): Record<string, unknown>[] {
  const row = (id: string, type: string, parentObservationId?: string) => ({
    id, traceId, type, parentObservationId,
  });
  const generation = (id: string, parent: string) => ({
    ...row(id, "GENERATION", parent), model: "langfuse-smoke-model",
    usageDetails: { input: 12, output: 4 }, costDetails: { total: 0.000028 },
  });
  const checkpoint = (id: string, name: "save-checkpoint" | "reuse-checkpoint" | "validate-checkpoint",
    checkpointId: string, sequence: number, kind: "step_completed" | "publication_frozen",
    outcome: "saved" | "reused" | "validated") => ({
    ...row(id, "SPAN", "root"), name,
    metadata: {
      checkpointId, checkpointSequence: sequence, checkpointKind: kind,
      checkpointSchemaVersion: 1, checkpointRuntimeVersionHash: "a".repeat(64),
      checkpointStateHash: sequence.toString(16).padStart(64, "0"),
      checkpointCreatedAt: "2026-10-31T00:00:00.000Z", checkpointOutcome: outcome,
      ...(kind === "step_completed"
        ? { stepId: `step-${sequence}`, stepAttemptId: `attempt-${sequence}`,
          outputHash: "b".repeat(64), artifactHash: "c".repeat(64) }
        : { publicationBatchId: "publication-batch" }),
    },
  });
  const cachedCheckpointId = "checkpoint-cached";
  return [
    row("root", "AGENT"),
    row("security", "AGENT", "root"), row("correctness", "AGENT", "root"),
    row("critic", "AGENT", "root"), row("capture", "SPAN", "root"),
    row("cached", "SPAN", "root"), row("tool", "TOOL", "root"),
    row("security-model", "SPAN", "security"), row("security-result", "SPAN", "security"),
    row("correctness-model", "SPAN", "correctness"), row("correctness-result", "SPAN", "correctness"),
    row("critic-model", "SPAN", "critic"), row("critic-result", "SPAN", "critic"),
    generation("security-generation", "security-model"),
    generation("correctness-generation", "correctness-model"),
    generation("critic-generation", "critic-model"),
    checkpoint("checkpoint-validate", "validate-checkpoint", cachedCheckpointId, 1, "step_completed", "validated"),
    checkpoint("checkpoint-reuse", "reuse-checkpoint", cachedCheckpointId, 1, "step_completed", "reused"),
    ...Array.from({ length: 7 }, (_, index) => checkpoint(`checkpoint-save-${index + 2}`,
      "save-checkpoint", `checkpoint-${index + 2}`, index + 2, "step_completed", "saved")),
    checkpoint("checkpoint-publication", "save-checkpoint", "checkpoint-9", 9,
      "publication_frozen", "saved"),
  ];
}

async function fixtureServer(
  handler: Parameters<typeof createServer>[0],
): Promise<{ origin: string; close(): Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server address unavailable");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}
