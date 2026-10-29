import { ProviderHttpError } from "../../core/provider-http-error.js";
import type { RepositoryReadAdapter, RepositoryReadFile } from "../../repository/contracts.js";
import { assertSafePath } from "../../repository/content-safety/repository-content.js";
import { boundedJson } from "../../core/http/bounded-json.js";
import { repositoryReadSignal } from "../../repository/read-signal.js";

export interface GitLabRepositoryReadAdapterOptions {
  baseUrl: string;
  token: string;
  projectId: number;
  headSha: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Fixed-project, fixed-SHA GitLab reader. Every network operation is a GET. */
export class GitLabRepositoryReadAdapter implements RepositoryReadAdapter {
  private readonly fetcher: typeof fetch;
  private readonly base: string;

  constructor(private readonly options: GitLabRepositoryReadAdapterOptions) {
    if (!options.token || !Number.isSafeInteger(options.projectId) || options.projectId <= 0
        || !/^[a-f0-9]{40,64}$/i.test(options.headSha)) {
      throw new Error("GitLab read binding is incomplete");
    }
    const origin = new URL(options.baseUrl);
    if (origin.username || origin.password || origin.search || origin.hash) throw new Error("GitLab API origin must not contain credentials or a query");
    if (origin.protocol !== "https:" && origin.hostname !== "localhost" && origin.hostname !== "127.0.0.1") {
      throw new Error("GitLab API origin must use HTTPS");
    }
    this.base = origin.toString().replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
  }

  async readFile(path: string, signal?: AbortSignal): Promise<RepositoryReadFile | undefined> {
    const safePath = assertSafePath(path);
    const encodedPath = encodeURIComponent(safePath);
    const slash = safePath.lastIndexOf("/");
    const directory = slash < 0 ? "" : safePath.slice(0, slash);
    const fileName = slash < 0 ? safePath : safePath.slice(slash + 1);
    let entry: { name?: string; path?: string; type?: string; mode?: string } | undefined;
    for (let page = 1; page <= 20; page += 1) {
      const tree = await this.get(`/api/v4/projects/${this.options.projectId}/repository/tree` +
        `?ref=${encodeURIComponent(this.options.headSha)}&path=${encodeURIComponent(directory)}&per_page=100&page=${page}`, signal);
      if (!tree.ok) throw new ProviderHttpError("GitLab repository read", tree.status);
      const entries = await boundedJson<Array<{ name?: string; path?: string; type?: string; mode?: string }>>(tree, 512 * 1024);
      entry = entries.find((item) => item.name === fileName && item.path === safePath);
      if (entry) break;
      const next = tree.headers.get("x-next-page");
      if (!next) return undefined;
      if (next !== String(page + 1)) throw new Error("GitLab repository tree pagination is invalid");
      if (page === 20) throw new Error("GitLab directory exceeds the snapshot page limit");
    }
    if (!entry) return undefined;
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode ?? "")) {
      throw new Error("GitLab repository path is not a regular file in the fixed tree");
    }
    const metadata = await this.get(`/api/v4/projects/${this.options.projectId}/repository/files/${encodedPath}` +
      `?ref=${encodeURIComponent(this.options.headSha)}`, signal);
    if (metadata.status === 404) return undefined;
    if (!metadata.ok) throw new ProviderHttpError("GitLab repository read", metadata.status);
    const value = await boundedJson<{ file_path?: string; encoding?: string; content?: string; size?: number }>(metadata, 512 * 1024);
    if (value.file_path !== safePath || value.encoding !== "base64" || typeof value.content !== "string") {
      throw new Error("GitLab repository read returned invalid file content");
    }
    if (typeof value.size === "number" && value.size > 256 * 1024) throw new Error("GitLab repository file exceeds the read limit");
    return { path: safePath, bytes: decodeBase64(value.content) };
  }

  async readCiStatus(signal?: AbortSignal): Promise<unknown> {
    const response = await this.get(`/api/v4/projects/${this.options.projectId}/repository/commits/` +
      `${encodeURIComponent(this.options.headSha)}/statuses?per_page=100`, signal);
    if (!response.ok) throw new ProviderHttpError("GitLab repository read", response.status);
    const value = await boundedJson<Array<Record<string, unknown>>>(response, 512 * 1024);
    return (Array.isArray(value) ? value : []).slice(0, 100).map((item) => ({
      name: item.name, status: item.status, allowFailure: item.allow_failure,
    }));
  }

  async listFiles(signal?: AbortSignal): Promise<string[]> {
    const paths: string[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const response = await this.get(`/api/v4/projects/${this.options.projectId}/repository/tree`+
        `?ref=${encodeURIComponent(this.options.headSha)}&recursive=true&per_page=100&page=${page}`, signal);
      if (!response.ok) throw new ProviderHttpError("GitLab repository tree read", response.status);
      const entries = await boundedJson<Array<{ path?: string; type?: string; mode?: string }>>(response, 512 * 1024);
      paths.push(...entries.filter((item): item is { path: string; type?: string; mode?: string } =>
        typeof item.path === "string" && item.type === "blob" && ["100644", "100755"].includes(item.mode ?? ""))
        .map(({ path }) => path));
      if (paths.length > 2_000) throw new Error("GitLab fixed tree exceeds the snapshot file limit");
      const next = response.headers.get("x-next-page");
      if (!next) return [...new Set(paths)].sort();
      if (next !== String(page + 1)) throw new Error("GitLab repository tree pagination is invalid");
    }
    throw new Error("GitLab fixed tree exceeds the snapshot page limit");
  }

  private get(path: string, signal?: AbortSignal): Promise<Response> {
    return this.fetcher(`${this.base}${path}`, { method: "GET", redirect: "error",
      signal: repositoryReadSignal(this.options.signal, this.options.timeoutMs, signal),
      headers: { "PRIVATE-TOKEN": this.options.token } });
  }
}

function decodeBase64(value: string): Buffer {
  const normalized = value.replace(/\s/g, "");
  if (normalized.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) {
    throw new Error("GitLab repository content has invalid base64 encoding");
  }
  return Buffer.from(normalized, "base64");
}
