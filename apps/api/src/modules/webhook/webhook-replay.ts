import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, resolve } from "node:path";

import {
  BadWebhookRequestError,
  WebhookAuthError,
  logCore,
  nowMs,
  parseBooleanEnv,
  readNumberEnv,
  readOptionalStringEnv,
} from "@mr-agent/core";
import { incrementMetricCounter } from "./metrics-runtime.js";
import { readHeaderValue, safeJsonStringify } from "./webhook.utils.js";

export type ReplayPlatform = "github" | "gitlab";

export interface StoredWebhookEvent {
  id: string;
  platform: ReplayPlatform;
  eventName: string;
  receivedAt: string;
  headers: Record<string, string>;
  payload?: unknown;
  rawBody?: string;
}

export interface StoredWebhookEventSummary {
  id: string;
  platform: ReplayPlatform;
  eventName: string;
  receivedAt: string;
  hasPayload: boolean;
  payloadSizeBytes: number;
}

interface RecordWebhookEventParams {
  platform: ReplayPlatform;
  eventName: string;
  headers: Record<string, string | string[] | undefined>;
  payload?: unknown;
  rawBody?: string;
}

const DEFAULT_WEBHOOK_EVENT_STORE_FILE = ".mr-agent-webhook-events.ndjson";
const DEFAULT_WEBHOOK_EVENT_STORE_MAX_ENTRIES = 2_000;
const DEFAULT_WEBHOOK_EVENT_STORE_MAX_BODY_BYTES = 512 * 1024;
const DEFAULT_WEBHOOK_EVENT_STORE_SAMPLE_RATE = 1;
const DEFAULT_WEBHOOK_EVENT_LIST_LIMIT = 20;
const MAX_WEBHOOK_EVENT_LIST_LIMIT = 200;
const TRIM_STORE_INTERVAL_WRITES = 20;

interface WebhookStoreWriteState {
  writesSinceLastTrim: number;
  queue: Promise<void>;
}

const writeState: WebhookStoreWriteState = {
  writesSinceLastTrim: 0,
  queue: Promise.resolve(),
};

export function recordWebhookEvent(params: RecordWebhookEventParams): string | undefined {
  if (!shouldStoreWebhookEvent()) {
    return undefined;
  }

  const stored = buildStoredWebhookEvent(params);
  enqueueStoredWebhookWrite(stored);
  return stored.id;
}

export function scheduleWebhookEventRecord(params: RecordWebhookEventParams): void {
  if (!shouldStoreWebhookEvent()) {
    return;
  }

  const stored = buildStoredWebhookEvent(params);
  enqueueStoredWebhookWrite(stored);
}

export async function flushWebhookStoreWrites(): Promise<void> {
  await writeState.queue;
}

function enqueueStoredWebhookWrite(event: StoredWebhookEvent): void {
  writeState.queue = writeState.queue
    .then(async () => {
      await persistStoredWebhookEventBestEffortAsync(event);
    })
    .catch((err) => {
      logCore("error", "webhook_replay.store_write_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

function buildStoredWebhookEvent(params: RecordWebhookEventParams): StoredWebhookEvent {
  const id = buildStoredWebhookEventId(params.platform);
  const rawBody = buildStoredRawBody(params.rawBody, params.payload);
  return {
    id,
    platform: params.platform,
    eventName: params.eventName.trim().toLowerCase() || "unknown",
    receivedAt: new Date(nowMs()).toISOString(),
    headers: sanitizeHeaders(params.headers),
    payload: params.payload,
    rawBody,
  };
}

async function persistStoredWebhookEventBestEffortAsync(event: StoredWebhookEvent): Promise<void> {
  try {
    await persistStoredWebhookEventAsync(event);
    incrementMetricCounter("mr_agent_webhook_store_writes_total", {
      platform: event.platform,
    });

    writeState.writesSinceLastTrim += 1;
    if (writeState.writesSinceLastTrim >= TRIM_STORE_INTERVAL_WRITES) {
      writeState.writesSinceLastTrim = 0;
      await trimStoredWebhookEventsAsync();
    }
  } catch {
    // Best-effort debug storage. Runtime behavior should never fail on replay storage errors.
  }
}

function shouldStoreWebhookEvent(): boolean {
  if (!isWebhookEventStoreEnabled()) {
    return false;
  }

  const parsed = Number(readOptionalStringEnv("WEBHOOK_EVENT_STORE_SAMPLE_RATE"));
  const sampleRate = Number.isFinite(parsed)
    ? Math.min(1, Math.max(0, parsed))
    : DEFAULT_WEBHOOK_EVENT_STORE_SAMPLE_RATE;
  if (sampleRate <= 0) {
    return false;
  }
  if (sampleRate >= 1) {
    return true;
  }

  return Math.random() < sampleRate;
}

export async function listStoredWebhookEvents(params?: {
  platform?: ReplayPlatform;
  limit?: number;
}): Promise<StoredWebhookEventSummary[]> {
  if (!isWebhookEventStoreEnabled()) {
    return [];
  }

  await writeState.queue;
  const limit = resolveWebhookEventListLimit(params?.limit);
  const events = await readStoredWebhookEvents();
  const selected: StoredWebhookEventSummary[] = [];

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index];
    if (!item) {
      continue;
    }
    if (params?.platform && item.platform !== params.platform) {
      continue;
    }

    const payloadText =
      typeof item.rawBody === "string"
        ? item.rawBody
        : typeof item.payload === "undefined"
          ? ""
          : safeJsonStringify(item.payload);

    selected.push({
      id: item.id,
      platform: item.platform,
      eventName: item.eventName,
      receivedAt: item.receivedAt,
      hasPayload: Boolean(item.rawBody) || typeof item.payload !== "undefined",
      payloadSizeBytes: Buffer.byteLength(payloadText, "utf8"),
    });

    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
}

export async function getStoredWebhookEventById(params: {
  id: string;
  platform?: ReplayPlatform;
}): Promise<StoredWebhookEvent | undefined> {
  if (!isWebhookEventStoreEnabled()) {
    return undefined;
  }

  const targetId = params.id.trim();
  if (!targetId) {
    return undefined;
  }

  await writeState.queue;
  const events = await readStoredWebhookEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index];
    if (!item || item.id !== targetId) {
      continue;
    }
    if (params.platform && item.platform !== params.platform) {
      continue;
    }
    return item;
  }

  return undefined;
}

export function resolveStoredWebhookReplayPayload(event: StoredWebhookEvent): unknown {
  if (typeof event.payload !== "undefined") {
    return event.payload;
  }

  if (typeof event.rawBody !== "string" || !event.rawBody.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(event.rawBody) as unknown;
  } catch {
    return undefined;
  }
}

export function isWebhookReplayEnabled(
  rawValue: string | undefined = readOptionalStringEnv("WEBHOOK_REPLAY_ENABLED"),
): boolean {
  return parseBooleanEnv(rawValue);
}

export function assertWebhookReplayAuthorized(
  headers: Record<string, string | string[] | undefined>,
): void {
  if (!isWebhookReplayEnabled()) {
    throw new BadWebhookRequestError(
      "webhook replay endpoint is disabled; set WEBHOOK_REPLAY_ENABLED=true to enable",
    );
  }

  const expected = readOptionalStringEnv("WEBHOOK_REPLAY_TOKEN");
  if (!expected) {
    throw new BadWebhookRequestError(
      "WEBHOOK_REPLAY_TOKEN must be configured when WEBHOOK_REPLAY_ENABLED=true",
    );
  }

  const actual = readHeaderValue(headers, "x-mr-agent-replay-token")?.trim();
  if (!actual) {
    throw new WebhookAuthError("invalid replay token", 403);
  }

  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  if (!timingSafeEqual(expectedDigest, actualDigest)) {
    throw new WebhookAuthError("invalid replay token", 403);
  }
}

export function resolveWebhookEventListLimit(rawLimit: number | string | undefined): number {
  const parsed = typeof rawLimit === "number" ? rawLimit : Number(rawLimit);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_WEBHOOK_EVENT_LIST_LIMIT;
  }

  const normalized = Math.floor(parsed);
  if (normalized < 1) {
    return 1;
  }

  return Math.min(MAX_WEBHOOK_EVENT_LIST_LIMIT, normalized);
}

function isWebhookEventStoreEnabled(
  rawValue: string | undefined = readOptionalStringEnv("WEBHOOK_EVENT_STORE_ENABLED"),
): boolean {
  return parseBooleanEnv(rawValue);
}

function buildStoredWebhookEventId(platform: ReplayPlatform): string {
  const timestamp = nowMs().toString(36);
  const random = randomUUID().slice(0, 8);
  return `${platform}-${timestamp}-${random}`;
}

function buildStoredRawBody(rawBody: string | undefined, payload: unknown): string | undefined {
  const maxBodyBytes = Math.max(
    1,
    readNumberEnv(
      "WEBHOOK_EVENT_STORE_MAX_BODY_BYTES",
      DEFAULT_WEBHOOK_EVENT_STORE_MAX_BODY_BYTES,
    ),
  );

  const source =
    typeof rawBody === "string"
      ? rawBody
      : typeof payload === "undefined"
        ? ""
        : safeJsonStringify(payload);
  if (!source) {
    return undefined;
  }

  const sourceBuffer = Buffer.from(source, "utf8");
  if (sourceBuffer.length <= maxBodyBytes) {
    return source;
  }

  return truncateToValidUtf8(sourceBuffer.subarray(0, maxBodyBytes)).toString("utf8");
}

function truncateToValidUtf8(buf: Buffer): Buffer {
  let end = buf.length;
  // Walk back past any UTF-8 continuation bytes (0b10xxxxxx = 0x80..0xBF).
  while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) {
    end--;
  }
  // If we landed on a multi-byte lead byte, check if the full sequence fits.
  if (end > 0) {
    const lead = buf[end - 1]!;
    let expectedLen = 1;
    if ((lead & 0xe0) === 0xc0) expectedLen = 2;
    else if ((lead & 0xf0) === 0xe0) expectedLen = 3;
    else if ((lead & 0xf8) === 0xf0) expectedLen = 4;
    const available = buf.length - (end - 1);
    if (available < expectedLen) {
      end--;
    }
  }
  return buf.subarray(0, end);
}

function sanitizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const includeSensitive = parseBooleanEnv(
    readOptionalStringEnv("WEBHOOK_EVENT_STORE_INCLUDE_SENSITIVE_HEADERS"),
  );
  const sanitized: Record<string, string> = {};
  const allowedKeys = new Set([
    "x-github-event",
    "x-github-delivery",
    "x-gitlab-event",
    "x-gitlab-delivery",
    "x-gitlab-instance",
    "content-type",
    "user-agent",
  ]);

  for (const [keyRaw, valueRaw] of Object.entries(headers)) {
    const key = keyRaw.trim().toLowerCase();
    const value = Array.isArray(valueRaw) ? valueRaw[0] : valueRaw;
    if (!value) {
      continue;
    }

    const isSensitiveHeader =
      key === "x-hub-signature-256" ||
      key === "x-gitlab-token" ||
      key === "x-gitlab-api-token" ||
      key === "authorization";

    if (!includeSensitive) {
      if (!allowedKeys.has(key) || isSensitiveHeader) {
        continue;
      }
    }

    sanitized[key] = value;
  }

  return sanitized;
}

async function persistStoredWebhookEventAsync(event: StoredWebhookEvent): Promise<void> {
  const filePath = resolveWebhookEventStoreFile();
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${safeJsonStringify(event)}\n`, "utf8");
}

async function trimStoredWebhookEventsAsync(): Promise<void> {
  const events = await readStoredWebhookEvents();
  const maxEntries = Math.max(
    1,
    readNumberEnv(
      "WEBHOOK_EVENT_STORE_MAX_ENTRIES",
      DEFAULT_WEBHOOK_EVENT_STORE_MAX_ENTRIES,
    ),
  );

  if (events.length <= maxEntries) {
    return;
  }

  const kept = events.slice(events.length - maxEntries);
  const filePath = resolveWebhookEventStoreFile();
  await mkdir(dirname(filePath), { recursive: true });
  const tempFilePath = `${filePath}.tmp-${nowMs()}-${randomUUID().slice(0, 8)}`;
  await writeFile(tempFilePath, `${kept.map((event) => safeJsonStringify(event)).join("\n")}\n`, "utf8");
  try {
    await rename(tempFilePath, filePath);
  } catch (renameError) {
    await rm(tempFilePath, { force: true }).catch(() => {});
    throw renameError;
  }
  incrementMetricCounter("mr_agent_webhook_store_trim_total", {
    result: "trimmed",
  });
}

async function readStoredWebhookEvents(): Promise<StoredWebhookEvent[]> {
  const filePath = resolveWebhookEventStoreFile();
  try {
    const raw = await readFile(filePath, "utf8");
    return parseStoredWebhookEventsText(raw);
  } catch {
    return [];
  }
}

function parseStoredWebhookEventsText(raw: string): StoredWebhookEvent[] {
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const events: StoredWebhookEvent[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      const normalized = normalizeStoredWebhookEvent(parsed);
      if (normalized) {
        events.push(normalized);
      }
    } catch {
      continue;
    }
  }
  return events;
}

function normalizeStoredWebhookEvent(input: unknown): StoredWebhookEvent | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const root = input as {
    id?: unknown;
    platform?: unknown;
    eventName?: unknown;
    receivedAt?: unknown;
    headers?: unknown;
    payload?: unknown;
    rawBody?: unknown;
  };

  if (typeof root.id !== "string" || typeof root.receivedAt !== "string") {
    return undefined;
  }
  if (root.platform !== "github" && root.platform !== "gitlab") {
    return undefined;
  }

  const headers: Record<string, string> = {};
  if (root.headers && typeof root.headers === "object" && !Array.isArray(root.headers)) {
    for (const [key, value] of Object.entries(root.headers as Record<string, unknown>)) {
      if (typeof value === "string") {
        headers[key] = value;
      }
    }
  }

  return {
    id: root.id,
    platform: root.platform,
    eventName:
      typeof root.eventName === "string" ? root.eventName.trim().toLowerCase() : "unknown",
    receivedAt: root.receivedAt,
    headers,
    payload: root.payload,
    rawBody: typeof root.rawBody === "string" ? root.rawBody : undefined,
  };
}

function resolveWebhookEventStoreFile(): string {
  const raw = readOptionalStringEnv("WEBHOOK_EVENT_STORE_FILE");
  if (!raw) {
    return resolve(process.cwd(), DEFAULT_WEBHOOK_EVENT_STORE_FILE);
  }
  return resolve(raw);
}
