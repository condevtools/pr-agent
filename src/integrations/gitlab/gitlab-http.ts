import { fetchWithRetry } from "#core";
import { buildGitLabHttpRetryOptions } from "../shared/http-retry-options.js";

export async function gitLabApiRequest(params: {
  url: string;
  token: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string | undefined>;
}): Promise<Response> {
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
      method: params.method ?? "GET",
      headers,
      body,
    },
    buildGitLabHttpRetryOptions(),
  );
}
