export function normalizeHeaderRecord(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }

  return normalized;
}

export function readHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  targetKey: string,
): string | undefined {
  const direct = headers[targetKey];
  if (typeof direct === "string") {
    return direct;
  }
  if (Array.isArray(direct)) {
    return direct[0];
  }

  const target = targetKey.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) {
      continue;
    }
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      return value[0];
    }
  }

  return undefined;
}

export function readRawBody(rawBody: Buffer | string | undefined): string | undefined {
  if (typeof rawBody === "string") {
    return rawBody;
  }
  if (Buffer.isBuffer(rawBody)) {
    return rawBody.toString("utf8");
  }
  return undefined;
}

export function safeJsonStringify(value: unknown, fallback = "null"): string {
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

export function formatLogMessage(message: string, metadata: unknown): string {
  if (!metadata) {
    return message;
  }

  try {
    return `${message} ${JSON.stringify(metadata)}`;
  } catch {
    return message;
  }
}
