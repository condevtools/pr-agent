import { fetchWithRetry } from "#core";
import { buildGitLabHttpRetryOptions } from "../shared/http-retry-options.js";
import { assertPublicationWriteAllowed } from "../../harness/write-boundary.js";

export async function gitLabApiRequest(params: {
  url: string;
  token: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string | undefined>;
  retry?: boolean;
}): Promise<Response> {
  const method = params.method ?? "GET";
  if (method !== "GET") assertPublicationWriteAllowed("gitlab");
  const headers: Record<string, string> = {
    "PRIVATE-TOKEN": params.token,
  };
  for (const [key, value] of Object.entries(params.headers ?? {})) {
    if (!value) {
      continue;
    }
    headers[key] = value;
  }
  if (typeof params.body !== "undefined" && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }

  const body =
    typeof params.body === "undefined"
      ? undefined
      : typeof params.body === "string"
        ? params.body
        : JSON.stringify(params.body);

  return fetchWithRetry(
    params.url,
    {
      method,
      headers,
      body,
    },
    params.retry === false
      ? { ...buildGitLabHttpRetryOptions(), retries: 0 }
      : buildGitLabHttpRetryOptions(),
  );
}
