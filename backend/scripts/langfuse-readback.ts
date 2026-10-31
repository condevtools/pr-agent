export interface LangfuseTraceVerification {
  verified: true;
  observations: number;
}

export async function verifyLangfuseTrace(input: {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  traceId: string;
  serverVersion: string;
  deadlineMs?: number;
  pollMs?: number;
}): Promise<LangfuseTraceVerification> {
  const deadline = Date.now() + (input.deadlineMs ?? 30_000);
  const pollMs = input.pollMs ?? 500;
  while (Date.now() < deadline) {
    const observations = await fetchObservations(input, Math.min(3_000, Math.max(1, deadline - Date.now())));
    const verification = verifyObservationTree(observations, input.traceId);
    if (verification) return verification;
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  throw namedError("LangfuseReadbackTimeoutError");
}

async function fetchObservations(
  input: Parameters<typeof verifyLangfuseTrace>[0],
  timeoutMs: number,
): Promise<Record<string, unknown>[]> {
  const url = observationsUrl(input.baseUrl, input.traceId, input.serverVersion);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Basic ${Buffer.from(`${input.publicKey.trim()}:${input.secretKey.trim()}`).toString("base64")}` },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return [];
  }
  if (response.status === 401 || response.status === 403) {
    throw namedError("LangfuseReadbackUnauthorizedError");
  }
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) return [];
    throw namedError("LangfuseReadbackRequestError");
  }
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw namedError("LangfuseReadbackResponseError"); }
  const data = payload && typeof payload === "object" && "data" in payload
    ? (payload as { data?: unknown }).data : undefined;
  return Array.isArray(data)
    ? data.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    : [];
}

function observationsUrl(baseUrl: string, traceId: string, version: string): URL {
  const major = Number.parseInt(version.split(".")[0] ?? "0", 10);
  const path = major >= 4 ? "/api/public/v2/observations" : "/api/public/observations";
  const url = new URL(path, baseUrl.trim());
  url.searchParams.set("traceId", traceId);
  url.searchParams.set("limit", "100");
  if (major >= 4) url.searchParams.set("fields", "core,basic,model,usage");
  return url;
}

function verifyObservationTree(
  observations: Record<string, unknown>[],
  traceId: string,
): LangfuseTraceVerification | undefined {
  const rows = observations.filter((row) => row.traceId === traceId);
  if (rows.length !== 16) return undefined;
  const ids = new Set(rows.flatMap((row) => typeof row.id === "string" ? [row.id] : []));
  if (ids.size !== rows.length) return undefined;
  const roots = rows.filter((row) => !parentId(row));
  if (roots.length !== 1 || normalizedType(roots[0]) !== "AGENT") return undefined;
  if (rows.some((row) => parentId(row) && !ids.has(parentId(row)!))) return undefined;
  const agents = rows.filter((row) => normalizedType(row) === "AGENT");
  const generations = rows.filter((row) => normalizedType(row) === "GENERATION");
  if (agents.length !== 4 || generations.length !== 3) return undefined;
  if (!generations.every(validGeneration)) return undefined;
  return { verified: true, observations: rows.length };
}

function validGeneration(row: Record<string, unknown>): boolean {
  if (row.model !== "langfuse-smoke-model") return false;
  const usage = objectNumbers(row.usageDetails ?? row.usage);
  const hasUsage = (usage.input ?? usage.input_tokens) === 12 &&
    (usage.output ?? usage.output_tokens) === 4;
  const costs = objectNumbers(row.costDetails);
  return hasUsage && typeof costs.total === "number" && Math.abs(costs.total - 0.000028) < 1e-12;
}

function objectNumbers(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .flatMap(([key, item]) => typeof item === "number" && Number.isFinite(item) ? [[key, item]] : []));
}

function parentId(row: Record<string, unknown>): string | undefined {
  const value = row.parentObservationId ?? row.parentSpanId;
  return typeof value === "string" && value ? value : undefined;
}

function normalizedType(row: Record<string, unknown>): string {
  return typeof row.type === "string" ? row.type.toUpperCase() : "";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
