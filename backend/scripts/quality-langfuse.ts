import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MANAGED_PROMPT_CATALOG } from "../src/quality/prompts/index.js";

interface CliRequest { method: "GET" | "POST"; path: string; body?: Record<string, unknown>; key?: string }
interface ApiClient { request<T>(input: CliRequest): Promise<T> }

export interface ParsedQualityCli {
  command: string;
  options: Readonly<Record<string, string | boolean>>;
}

export function parseQualityCliArguments(argv: readonly string[]): ParsedQualityCli {
  const positional: string[] = []; const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) { positional.push(value); continue; }
    const name = value.slice(2);
    if (!name || name in options) throw new Error(`Invalid or duplicate option: ${value}`);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) options[name] = true;
    else { options[name] = next; index += 1; }
  }
  if (positional.length < 2 || positional.length > 2) throw new Error(usage());
  return { command: `${positional[0]}:${positional[1]}`, options };
}

export async function runQualityCli(argv: readonly string[], env: NodeJS.ProcessEnv = process.env,
  output: (value: unknown) => void = print): Promise<void> {
  if (argv.length === 0 || argv.includes("--help")) { output({ usage: usage() }); return; }
  const parsed = parseQualityCliArguments(argv);
  const client = createApiClient(env);
  if (parsed.command === "prompts:bootstrap") {
    output(await bootstrapPrompts(client, parsed.options)); return;
  }
  const request = await requestFor(parsed);
  output(await client.request(request));
}

function createApiClient(env: NodeJS.ProcessEnv): ApiClient {
  const rawUrl = env.PR_AGENT_API_URL?.trim(); const token = env.PR_AGENT_API_TOKEN?.trim();
  if (!rawUrl || !token) throw new Error("PR_AGENT_API_URL and PR_AGENT_API_TOKEN are required");
  const base = new URL(rawUrl);
  if (base.username || base.password || base.search || base.hash) throw new Error("PR_AGENT_API_URL must not contain credentials, query, or fragment");
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(base.hostname))) {
    throw new Error("PR_AGENT_API_URL must use HTTPS except for loopback development");
  }
  return {
    async request<T>(input: CliRequest): Promise<T> {
      const response = await fetch(new URL(input.path, withSlash(base)), {
        method: input.method,
        headers: { authorization: `Bearer ${token}`, accept: "application/json",
          ...(input.body ? { "content-type": "application/json" } : {}),
          ...(input.key ? { "idempotency-key": input.key } : {}) },
        body: input.body ? JSON.stringify(input.body) : undefined,
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
      const text = await response.text();
      let value: unknown;
      try { value = text ? JSON.parse(text) : {}; }
      catch { value = { error: { code: "INVALID_API_RESPONSE", status: response.status } }; }
      if (!response.ok) throw new Error(`Quality API request failed (${response.status}): ${safeError(value)}`);
      return value as T;
    },
  };
}

async function requestFor(input: ParsedQualityCli): Promise<CliRequest> {
  const option = (name: string) => requiredOption(input.options, name);
  const key = () => option("idempotency-key");
  switch (input.command) {
    case "prompts:list": return { method: "GET", path: "/quality/prompts" };
    case "prompts:pull": return { method: "POST", path: "/quality/prompts/pull", key: key(), body: {
      promptKey: option("prompt-key"), remoteName: option("remote-name"), version: positiveInteger(option("version")),
      seed: input.options.seed === true,
    } };
    case "prompts:activate": return { method: "POST", path: `/quality/prompts/${uuid(option("id"))}/activate`,
      key: key(), body: { promptKey: option("prompt-key"), expectedContentHash: hash(option("content-hash")),
        expectedSourceFingerprint: hash(option("source-fingerprint")) } };
    case "datasets:export": return { method: "POST", path: "/quality/exports/datasets", key: key(), body: {
      datasetId: uuid(option("dataset-id")), split: oneOf(option("split"), ["development", "validation"]),
      expectedManifestHash: hash(option("manifest-hash")),
    } };
    case "evaluations:export": return evaluationRequest(input.options, false);
    case "evaluations:scores": return evaluationRequest(input.options, true);
    case "judge:export": return { method: "POST", path: "/quality/exports/scores", key: key(),
      body: { judgeRunId: uuid(option("id")) } };
    case "annotations:queue": return annotationSyncRequest(input.options, "queue");
    case "annotations:pull": return annotationSyncRequest(input.options, "pull");
    case "annotations:inbox": return { method: "GET", path: withQuery("/quality/annotations/inbox", input.options,
      ["state", "source-run-id", "limit"]) };
    case "annotations:reject": return { method: "POST",
      path: `/quality/annotations/inbox/${uuid(option("id"))}/reject`,
      body: { expectedContentHash: hash(option("content-hash")) } };
    case "annotations:promote": return { method: "POST",
      path: `/quality/annotations/inbox/${uuid(option("id"))}/promote`,
      body: { expectedContentHash: hash(option("content-hash")), artifactHash: hash(option("artifact-hash")),
        labelSet: await readJsonFile(option("label-set-file")),
        ...(typeof input.options.notes === "string" ? { notes: input.options.notes } : {}),
        ...(typeof input.options["supersedes-annotation-id"] === "string"
          ? { supersedesAnnotationId: uuid(input.options["supersedes-annotation-id"]) } : {}) } };
    case "jobs:list": return { method: "GET", path: withQuery("/quality/jobs", input.options,
      ["status", "kind", "limit"]) };
    case "jobs:get": return { method: "GET", path: `/quality/jobs/${uuid(option("id"))}` };
    case "jobs:retry": return { method: "POST", path: `/quality/jobs/${uuid(option("id"))}/retry`, key: key(),
      body: { expectedVersion: positiveInteger(option("version")) } };
    case "judge:run": return { method: "POST", path: "/quality/evaluators/judge", key: key(), body: {
      sourceRunId: uuid(option("source-run-id")), expectedArtifactHash: hash(option("artifact-hash")),
    } };
    case "judge:get": return { method: "GET", path: `/quality/evaluators/judge/${uuid(option("id"))}` };
    default: throw new Error(usage());
  }
}

async function bootstrapPrompts(client: ApiClient, options: Readonly<Record<string, string | boolean>>) {
  const timeoutMs = typeof options["timeout-ms"] === "string" ? positiveInteger(options["timeout-ms"]) : 120_000;
  if (timeoutMs > 15 * 60_000) throw new Error("--timeout-ms must not exceed 900000");
  const activated: Array<{ key: string; promptVersionId: string }> = [];
  for (const definition of Object.values(MANAGED_PROMPT_CATALOG)) {
    const key = `bootstrap:${definition.key}:v1`;
    const job = await client.request<{ id: string }>({ method: "POST", path: "/quality/prompts/pull", key,
      body: { promptKey: definition.key, remoteName: definition.name, version: 1, seed: true } });
    const completed = await pollJob(client, job.id, timeoutMs);
    const result = object(completed.result);
    const promptVersionId = uuid(stringField(result, "promptVersionId"));
    await client.request({ method: "POST", path: `/quality/prompts/${promptVersionId}/activate`,
      key: `activate:${definition.key}:v1`, body: { promptKey: definition.key,
        expectedContentHash: hash(stringField(result, "contentHash")),
        expectedSourceFingerprint: hash(stringField(result, "sourceFingerprint")) } });
    activated.push({ key: definition.key, promptVersionId });
  }
  return { activated };
}

async function pollJob(client: ApiClient, id: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await client.request<Record<string, unknown>>({ method: "GET", path: `/quality/jobs/${uuid(id)}` });
    if (job.status === "succeeded") return job;
    if (job.status === "dead_letter") throw new Error(`Bootstrap job failed: ${String(job.errorCode ?? "unknown")}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error("Timed out waiting for prompt bootstrap");
}

function evaluationRequest(options: Readonly<Record<string, string | boolean>>, scoresOnly: boolean): CliRequest {
  return { method: "POST", path: scoresOnly ? "/quality/exports/scores" : "/quality/exports/evaluations",
    key: requiredOption(options, "idempotency-key"), body: {
      evaluationId: uuid(requiredOption(options, "evaluation-id")),
      expectedManifestHash: hash(requiredOption(options, "manifest-hash")),
    } };
}
function annotationSyncRequest(options: Readonly<Record<string, string | boolean>>, kind: "queue" | "pull"): CliRequest {
  return { method: "POST", path: `/quality/annotations/${kind}`,
    key: requiredOption(options, "idempotency-key"),
    body: { sourceRunId: uuid(requiredOption(options, "source-run-id")) } };
}
function withQuery(path: string, options: Readonly<Record<string, string | boolean>>, names: readonly string[]): string {
  const query = new URLSearchParams();
  const apiNames: Record<string, string> = { "source-run-id": "sourceRunId" };
  for (const name of names) {
    const value = options[name];
    if (typeof value === "string") query.set(apiNames[name] ?? name, value);
  }
  const encoded = query.toString(); return encoded ? `${path}?${encoded}` : path;
}
async function readJsonFile(path: string): Promise<unknown> {
  const contents = await readFile(resolve(path), "utf8");
  if (Buffer.byteLength(contents, "utf8") > 1024 * 1024) throw new Error("JSON input file exceeds 1 MiB");
  return JSON.parse(contents) as unknown;
}
function requiredOption(options: Readonly<Record<string, string | boolean>>, name: string): string {
  const value = options[name]; if (typeof value !== "string" || !value) throw new Error(`--${name} is required`);
  return value;
}
function positiveInteger(value: string): number {
  const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Invalid positive integer: ${value}`);
  return parsed;
}
function hash(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("Expected a lowercase SHA-256 hash"); return value;
}
function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error("Expected a UUID");
  }
  return value;
}
function oneOf<T extends string>(value: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw new Error(`Expected one of: ${allowed.join(", ")}`); return value as T;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object response");
  return value as Record<string, unknown>;
}
function stringField(value: Record<string, unknown>, field: string): string {
  const item = value[field]; if (typeof item !== "string") throw new Error(`Bootstrap response is missing ${field}`); return item;
}
function withSlash(url: URL): URL { const copy = new URL(url); if (!copy.pathname.endsWith("/")) copy.pathname += "/"; return copy; }
function safeError(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "request rejected";
  const error = (value as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return "request rejected";
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : "request rejected";
}
function print(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function usage(): string {
  return "Usage: quality-langfuse <prompts|datasets|evaluations|annotations|jobs|judge> <command> [--options]";
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) runQualityCli(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Quality CLI failed"}\n`); process.exitCode = 1;
});
