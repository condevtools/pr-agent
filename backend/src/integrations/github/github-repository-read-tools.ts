import { ProviderHttpError } from "../../core/provider-http-error.js";

import type { RepositoryReadAdapter, RepositoryReadFile } from "../../repository/contracts.js";
import { assertSafePath } from "../../repository/content-safety/repository-content.js";
import { boundedJson } from "../../core/http/bounded-json.js";
import { repositoryReadSignal } from "../../repository/read-signal.js";

export interface GitHubRepositoryReadAdapterOptions {
  apiBaseUrl: string;
  token: string;
  owner: string;
  repo: string;
  headSha: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Provider adapter whose public surface cannot choose a repository, ref, URL, method, or credential. */
export class GitHubRepositoryReadAdapter implements RepositoryReadAdapter {
  private readonly fetcher: typeof fetch;
  private readonly base: string;
  private treeEntries?: Promise<Map<string, { mode?: string; type?: string }>>;

  constructor(private readonly options: GitHubRepositoryReadAdapterOptions) {
    if (!options.token || !options.owner || !options.repo || !/^[a-f0-9]{40,64}$/i.test(options.headSha)) throw new Error("GitHub read binding is incomplete");
    const origin = new URL(options.apiBaseUrl);
    if (origin.username || origin.password || origin.search || origin.hash) throw new Error("GitHub API origin must not contain credentials or a query");
    if (origin.protocol !== "https:" && origin.hostname !== "localhost" && origin.hostname !== "127.0.0.1") {
      throw new Error("GitHub API origin must use HTTPS");
    }
    this.base = origin.toString().replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
  }

  async readFile(path: string, signal?: AbortSignal): Promise<RepositoryReadFile | undefined> {
    const safePath = assertSafePath(path);
    const entry = (await (this.treeEntries ??= this.loadTree(signal))).get(safePath);
    if (!entry) return undefined;
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode ?? "")) {
      throw new Error("GitHub repository path is not a regular file in the fixed tree");
    }
    const response = await this.get(`/repos/${encodeURIComponent(this.options.owner)}/${encodeURIComponent(this.options.repo)}` +
      `/contents/${safePath.split("/").map((segment) => encodeURIComponent(segment)).join("/")}?ref=${encodeURIComponent(this.options.headSha)}`, signal);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new ProviderHttpError("GitHub repository read", response.status);
    const value = await boundedJson<{ type?: string; path?: string; encoding?: string; content?: string; size?: number }>(response, 512 * 1024);
    if (value.type !== "file" || value.path !== safePath || value.encoding !== "base64" || typeof value.content !== "string") {
      throw new Error("GitHub repository read returned non-file content");
    }
    if (typeof value.size === "number" && value.size > 256 * 1024) throw new Error("GitHub repository file exceeds the read limit");
    return { path: safePath, bytes: decodeBase64(value.content) };
  }

  async readCiStatus(signal?: AbortSignal): Promise<unknown> {
    const response = await this.get(`/repos/${encodeURIComponent(this.options.owner)}/${encodeURIComponent(this.options.repo)}` +
      `/commits/${encodeURIComponent(this.options.headSha)}/check-runs?per_page=100`, signal);
    if (!response.ok) throw new ProviderHttpError("GitHub repository read", response.status);
    const value = await boundedJson<{ check_runs?: Array<Record<string, unknown>> }>(response, 512 * 1024);
    return (value.check_runs ?? []).slice(0, 100).map((item) => ({
      name: item.name, status: item.status, conclusion: item.conclusion,
    }));
  }

  async listFiles(signal?: AbortSignal): Promise<string[]> {
    const entries = await (this.treeEntries ??= this.loadTree(signal));
    const paths = [...entries.entries()].filter(([, entry]) => entry.type === "blob"
      && ["100644", "100755"].includes(entry.mode ?? "")).map(([path]) => path).sort();
    if (paths.length === 0 || paths.length > 2_000) throw new Error("GitHub fixed tree exceeds the snapshot file limit");
    return paths;
  }

  private get(path: string, signal?: AbortSignal): Promise<Response> {
    return this.fetcher(`${this.base}${path}`, {
      method: "GET",
      redirect: "error",
      signal: repositoryReadSignal(this.options.signal, this.options.timeoutMs, signal),
      headers: { authorization: `Bearer ${this.options.token}`, accept: "application/vnd.github+json" },
    });
  }

  private async loadTree(signal?: AbortSignal): Promise<Map<string, { mode?: string; type?: string }>> {
    const tree = await this.get(`/repos/${encodeURIComponent(this.options.owner)}/${encodeURIComponent(this.options.repo)}` +
      `/git/trees/${encodeURIComponent(this.options.headSha)}?recursive=1`, signal);
    if (!tree.ok) throw new ProviderHttpError("GitHub repository read", tree.status);
    const value = await boundedJson<{ truncated?: boolean; tree?: Array<{ path?: string; mode?: string; type?: string }> }>(tree, 2 * 1024 * 1024);
    if (value.truncated) throw new Error("GitHub repository tree is truncated");
    return new Map((value.tree ?? []).filter((item): item is { path: string; mode?: string; type?: string } =>
      typeof item.path === "string").map((item) => [item.path, item]));
  }
}

function decodeBase64(value: string): Buffer {
  const normalized = value.replace(/\s/g, "");
  if (normalized.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) {
    throw new Error("GitHub repository content has invalid base64 encoding");
  }
  return Buffer.from(normalized, "base64");
}
