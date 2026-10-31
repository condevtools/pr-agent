import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, describe, it } from "node:test";
import {
  deterministicLangfuseId,
  LangfuseQualityClient,
  LangfuseQualityError,
} from "../../src/quality/langfuse/client.js";

type RecordedRequest = {
  method: string;
  url: string;
  authorization?: string;
  body?: unknown;
};

let createdQueueItem: { objectId: string; objectType: "TRACE" | "OBSERVATION" | "SESSION" } | undefined;

describe("LangfuseQualityClient", () => {
  const requests: RecordedRequest[] = [];
  let baseUrl = "";
  let server: ReturnType<typeof createServer>;

  before(async () => {
    server = createServer(async (request, response) => {
      const body = await readJson(request);
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization,
        body,
      });
      route(request, response, body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("uses stable UUIDs and awaits acknowledged dataset and score upserts", async () => {
    requests.length = 0;
    const client = qualityClient(baseUrl);

    const firstItem = await client.upsertDatasetItem({
      datasetName: "tenant/reviews",
      stableKey: "repo#42",
      input: { diff: "one" },
    });
    const secondItem = await client.upsertDatasetItem({
      datasetName: "tenant/reviews",
      stableKey: "repo#42",
      input: { diff: "two" },
    });
    const score = await client.upsertScore({
      stableKey: "policy-v1",
      traceId: "trace-42",
      name: "review_accepted",
      kind: "BOOLEAN",
      value: true,
    });

    assert.equal(firstItem.id, secondItem.id);
    assert.equal(firstItem.id, deterministicLangfuseId("dataset-item", "tenant/reviews", "repo#42"));
    assert.equal(score.id, deterministicLangfuseId("score", "trace-42", "", "review_accepted", "policy-v1"));
    const itemBodies = requests
      .filter((entry) => entry.url === "/api/public/dataset-items")
      .map((entry) => entry.body as { id: string });
    assert.deepEqual(itemBodies.map(({ id }) => id), [firstItem.id, firstItem.id]);
    const scoreRequest = requests.find((entry) => entry.url === "/api/public/scores");
    assert.deepEqual(scoreRequest?.body, {
      id: score.id,
      traceId: "trace-42",
      name: "review_accepted",
      value: 1,
      dataType: "BOOLEAN",
      source: "API",
    });
    assert.equal(scoreRequest?.authorization, `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`);
  });

  it("uses versioned text prompts and links dataset run items to traces", async () => {
    requests.length = 0;
    const client = qualityClient(baseUrl);

    const fetched = await client.getTextPrompt("review", 3);
    const created = await client.createTextPrompt({
      name: "review",
      text: "Review {{diff}}",
      config: { temperature: 0 },
      labels: ["production"],
    });
    const runItem = await client.linkDatasetRunItem({
      runName: "release-1",
      datasetItemId: "item-1",
      traceId: "trace-42",
    });

    assert.equal(fetched.version, 3);
    assert.equal(created.version, 4);
    assert.deepEqual(created.labels, ["production"]);
    assert.equal(runItem.traceId, "trace-42");
    assert(requests.some((entry) => entry.url === "/api/public/v2/prompts/review?version=3"));
    assert(requests.some((entry) => entry.url === "/api/public/dataset-run-items"));
  });

  it("gets or creates named resources idempotently and validates conflicting definitions", async () => {
    requests.length = 0;
    const client = qualityClient(baseUrl);

    const dataset = await client.getOrCreateDataset({ name: "existing" });
    const createdDataset = await client.getOrCreateDataset({ name: "new-dataset" });
    const scoreConfig = await client.getOrCreateScoreConfig({
      name: "acceptance",
      kind: "BOOLEAN",
    });
    const createdConfig = await client.getOrCreateScoreConfig({
      name: "relevance",
      kind: "NUMERIC",
      minValue: 0,
      maxValue: 1,
    });
    const queue = await client.getOrCreateAnnotationQueue({
      name: "review-queue",
      scoreConfigIds: [scoreConfig.id],
    });
    const queueItem = await client.addAnnotationQueueItem({
      queueId: queue.id,
      objectId: "trace-42",
      objectType: "TRACE",
    });
    const repeatedQueueItem = await client.addAnnotationQueueItem({
      queueId: queue.id,
      objectId: "trace-42",
      objectType: "TRACE",
    });

    assert.equal(dataset.id, "dataset-existing");
    assert.equal(createdDataset.id, "dataset-new-dataset");
    assert.equal(scoreConfig.id, "config-1");
    assert.equal(createdConfig.id, "config-2");
    assert.equal(queue.id, "queue-1");
    assert.equal(queueItem.objectId, "trace-42");
    assert.equal(repeatedQueueItem.id, queueItem.id);
    assert.equal(requests.filter((entry) => entry.method === "POST"
      && entry.url === "/api/public/annotation-queues/queue-1/items").length, 1);
    await assert.rejects(
      client.getOrCreateScoreConfig({ name: "acceptance", kind: "NUMERIC" }),
      (error) => error instanceof LangfuseQualityError && error.code === "LANGFUSE_QUALITY_CONFLICT",
    );
  });

  it("reads only paginated human annotations attached to the requested trace", async () => {
    requests.length = 0;
    const client = qualityClient(baseUrl);

    const scores = await client.listHumanAnnotationScores({
      traceId: "trace-42",
      pageSize: 2,
      maxPages: 3,
      maxItems: 3,
    });

    assert.deepEqual(scores.map(({ id }) => id), ["score-1", "score-4", "score-3"]);
    assert.equal(scores[2]?.observationId, "observation-1");
    const scoreRequests = requests.filter((entry) => entry.url.startsWith("/api/public/v3/scores"));
    assert.equal(scoreRequests.length, 2);
    assert.match(scoreRequests[0]!.url, /source=ANNOTATION/u);
    assert.match(scoreRequests[0]!.url, /traceId=trace-42/u);
    assert.match(scoreRequests[1]!.url, /cursor=next/u);
  });

  it("pages only annotations from the expected application queue and score config", async () => {
    const client = qualityClient(baseUrl);
    const page = await client.listHumanAnnotationScorePage({ traceId: "trace-42",
      queueId: "queue-1", configId: "config-1", limit: 100 });

    assert.deepEqual(page.scores.map(({ id }) => id), ["score-1"]);
    assert.equal(page.nextCursor, "next");
  });

  it("maps authentication failures without leaking credentials or response bodies", async () => {
    const client = qualityClient(`${baseUrl}/unauthorized`);
    await assert.rejects(
      client.getTextPrompt("secret-prompt", 1),
      (error) => {
        assert(error instanceof LangfuseQualityError);
        assert.equal(error.code, "LANGFUSE_QUALITY_UNAUTHORIZED");
        assert.doesNotMatch(error.message, /sk-test|sensitive-response/u);
        return true;
      },
    );
  });

  it("enforces the request timeout and bounded retry policy", async () => {
    requests.length = 0;
    const client = new LangfuseQualityClient({
      publicKey: "pk-test",
      secretKey: "sk-test",
      baseUrl: `${baseUrl}/slow`,
      timeoutMs: 100,
      maxRetries: 1,
    });

    await assert.rejects(
      client.getTextPrompt("slow", 1),
      (error) => error instanceof LangfuseQualityError && error.code === "LANGFUSE_QUALITY_TIMEOUT",
    );
    const attempts = requests.filter((entry) => entry.url.includes("/slow/api/public/v2/prompts/slow")).length;
    assert(attempts >= 1 && attempts <= 2);
  });

  it("passes lifecycle cancellation to the in-flight SDK request", async () => {
    const client = qualityClient(`${baseUrl}/slow`);
    const controller = new AbortController();
    const started = Date.now();
    const request = client.getTextPrompt("slow", 1, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);

    await assert.rejects(request, (error) => error instanceof LangfuseQualityError
      && error.code === "LANGFUSE_QUALITY_TIMEOUT");
    assert(Date.now() - started < 500);
  });

  it("rejects base URLs that embed credentials or URL control data", () => {
    for (const candidate of [
      "https://user:password@example.test",
      "https://example.test?redirect=https://attacker.test",
      "https://example.test/#fragment",
      "ftp://example.test",
    ]) {
      assert.throws(
        () => qualityClient(candidate),
        (error) => error instanceof LangfuseQualityError && error.code === "LANGFUSE_QUALITY_INVALID_CONFIG",
      );
    }
  });
});

function qualityClient(baseUrl: string): LangfuseQualityClient {
  return new LangfuseQualityClient({
    publicKey: "pk-test",
    secretKey: "sk-test",
    baseUrl,
    timeoutMs: 1_000,
    maxRetries: 0,
  });
}

function route(request: IncomingMessage, response: ServerResponse, body: unknown): void {
  const url = request.url ?? "";
  if (url.startsWith("/slow/")) {
    setTimeout(() => json(response, 200, prompt("slow", 1)), 250);
    return;
  }
  if (url.startsWith("/unauthorized/")) {
    json(response, 401, { message: "sensitive-response" });
    return;
  }
  if (request.method === "POST" && url === "/api/public/dataset-items") {
    const input = body as { id: string; datasetName: string };
    json(response, 200, {
      id: input.id,
      status: "ACTIVE",
      datasetId: "dataset-1",
      datasetName: input.datasetName,
      sourceTraceId: null,
      sourceObservationId: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      mediaReferences: [],
    });
    return;
  }
  if (request.method === "POST" && url === "/api/public/scores") {
    json(response, 200, { id: (body as { id: string }).id });
    return;
  }
  if (request.method === "GET" && url === "/api/public/v2/prompts/review?version=3") {
    json(response, 200, { ...prompt("review", 3), prompt: "Review {{diff}}" });
    return;
  }
  if (request.method === "POST" && url === "/api/public/v2/prompts") {
    const input = body as { name: string; prompt: string; config?: unknown; labels?: string[] };
    json(response, 200, { ...prompt(input.name, 4), prompt: input.prompt, config: input.config, labels: input.labels ?? [] });
    return;
  }
  if (request.method === "POST" && url === "/api/public/dataset-run-items") {
    const input = body as { runName: string; datasetItemId: string; traceId: string };
    json(response, 200, {
      id: "run-item-1",
      datasetRunId: "run-1",
      datasetRunName: input.runName,
      datasetItemId: input.datasetItemId,
      traceId: input.traceId,
      observationId: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    return;
  }
  if (request.method === "GET" && url === "/api/public/v2/datasets/existing") {
    json(response, 200, dataset("existing"));
    return;
  }
  if (request.method === "GET" && url === "/api/public/v2/datasets/new-dataset") {
    json(response, 404, { message: "not found" });
    return;
  }
  if (request.method === "POST" && url === "/api/public/v2/datasets") {
    json(response, 200, dataset((body as { name: string }).name));
    return;
  }
  if (request.method === "GET" && url.startsWith("/api/public/score-configs")) {
    json(response, 200, {
      data: [{
        id: "config-1",
        name: "acceptance",
        dataType: "BOOLEAN",
        isArchived: false,
        projectId: "project-1",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }],
      meta: { page: 1, limit: 100, totalItems: 1, totalPages: 1 },
    });
    return;
  }
  if (request.method === "POST" && url === "/api/public/score-configs") {
    const input = body as { name: string; dataType: string; minValue?: number; maxValue?: number };
    json(response, 200, {
      id: "config-2",
      ...input,
      isArchived: false,
      projectId: "project-1",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    return;
  }
  if (request.method === "GET" && url.startsWith("/api/public/annotation-queues?")) {
    json(response, 200, {
      data: [{
        id: "queue-1",
        name: "review-queue",
        description: null,
        scoreConfigIds: ["config-1"],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }],
      meta: { page: 1, limit: 100, totalItems: 1, totalPages: 1 },
    });
    return;
  }
  if (request.method === "GET" && url.startsWith("/api/public/annotation-queues/queue-1/items")) {
    json(response, 200, { data: createdQueueItem ? [{ id: "queue-item-1", queueId: "queue-1", ...createdQueueItem,
      status: "PENDING", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }] : [],
    meta: { page: 1, limit: 100, totalItems: createdQueueItem ? 1 : 0, totalPages: 1 } });
    return;
  }
  if (request.method === "POST" && url === "/api/public/annotation-queues/queue-1/items") {
    createdQueueItem = body as typeof createdQueueItem;
    json(response, 200, {
      id: "queue-item-1",
      queueId: "queue-1",
      ...(body as object),
      status: "PENDING",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    return;
  }
  if (request.method === "GET" && url.startsWith("/api/public/v3/scores")) {
    const secondPage = url.includes("cursor=next");
    json(response, 200, secondPage ? {
      data: [humanScore("score-3", { kind: "observation", id: "observation-1", traceId: "trace-42" })],
      meta: { limit: 1 },
    } : {
      data: [
        humanScore("score-1", { kind: "trace", id: "trace-42" }),
        humanScore("score-2", { kind: "trace", id: "other-trace" }),
        humanScore("score-4", { kind: "trace", id: "trace-42" }, { queueId: "other-queue" }),
      ],
      meta: { limit: 2, cursor: "next" },
    });
    return;
  }
  json(response, 404, { message: "not found" });
}

function prompt(name: string, version: number) {
  return { name, version, type: "text", prompt: "text", labels: [], tags: [] };
}

function dataset(name: string) {
  return {
    id: `dataset-${name}`,
    name,
    description: null,
    projectId: "project-1",
    inputSchema: null,
    expectedOutputSchema: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function humanScore(id: string, subject: object, identity: { queueId?: string; configId?: string } = {}) {
  return {
    id,
    projectId: "project-1",
    name: "human_acceptance",
    value: true,
    dataType: "BOOLEAN",
    source: "ANNOTATION",
    queueId: identity.queueId ?? "queue-1",
    configId: identity.configId ?? "config-1",
    timestamp: new Date(0).toISOString(),
    environment: "production",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    subject,
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
