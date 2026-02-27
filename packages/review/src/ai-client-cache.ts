import { createHash } from "node:crypto";
import OpenAI from "openai";

import { readNumberEnv } from "@mr-agent/core";

export interface OpenAIClientCacheConfig {
  apiKey: string;
  baseURL?: string;
  timeout: number;
  maxRetries: number;
  tenantId?: string;
}

export interface OpenAIClientCacheOptions {
  resolveMaxEntries?: () => number;
}

const DEFAULT_MAX_OPENAI_CLIENT_CACHE_ENTRIES = 200;

export class OpenAIClientCache {
  private readonly clients = new Map<string, OpenAI>();
  private readonly resolveMaxEntries: () => number;

  constructor(options?: OpenAIClientCacheOptions) {
    this.resolveMaxEntries =
      options?.resolveMaxEntries ??
      (() =>
        Math.max(
          1,
          readNumberEnv(
            "MAX_OPENAI_CLIENT_CACHE_ENTRIES",
            DEFAULT_MAX_OPENAI_CLIENT_CACHE_ENTRIES,
          ),
        ));
  }

  get(params: OpenAIClientCacheConfig): OpenAI {
    const key = openAIClientCacheKey(params);
    const cached = this.clients.get(key);
    if (cached) {
      this.clients.delete(key);
      this.clients.set(key, cached);
      this.trim();
      return cached;
    }

    const created = new OpenAI(
      params.baseURL
        ? {
            apiKey: params.apiKey,
            baseURL: params.baseURL,
            timeout: params.timeout,
            maxRetries: params.maxRetries,
          }
        : {
            apiKey: params.apiKey,
            timeout: params.timeout,
            maxRetries: params.maxRetries,
          },
    );
    this.clients.set(key, created);
    this.trim();
    return created;
  }

  clear(): void {
    this.clients.clear();
  }

  private trim(): void {
    const maxEntries = Math.max(1, Math.floor(this.resolveMaxEntries()));
    while (this.clients.size > maxEntries) {
      const oldest = this.clients.keys().next();
      if (oldest.done) {
        break;
      }
      this.clients.delete(oldest.value);
    }
  }
}

export function createOpenAIClientCache(
  options?: OpenAIClientCacheOptions,
): OpenAIClientCache {
  return new OpenAIClientCache(options);
}

export function openAIClientCacheKey(params: OpenAIClientCacheConfig): string {
  const parts = [
    hashApiKey(params.apiKey),
    params.baseURL ?? "",
    `${params.timeout}`,
    `${params.maxRetries}`,
  ];
  if (params.tenantId) {
    parts.push(`tenant:${params.tenantId}`);
  }
  return parts.join("|");
}

function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}
