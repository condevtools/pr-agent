import type { RepositoryReadAdapter, RepositoryReadFile } from "../repository/contracts.js";
import type { DatasetFixtureV1 } from "./dataset-contracts.js";

/** Immutable, credential-free replay adapter. It has no network-capable dependency. */
export class ReplayFixtureAdapter implements RepositoryReadAdapter {
  private readonly files: ReadonlyMap<string, RepositoryReadFile>;

  constructor(private readonly fixture: DatasetFixtureV1) {
    this.files = new Map(fixture.files.map((file) => [file.path,
      { path: file.path, mode: "100644", bytes: Buffer.from(file.content, "utf8") }]));
  }

  async readFile(path: string, signal?: AbortSignal): Promise<RepositoryReadFile | undefined> {
    signal?.throwIfAborted();
    const file = this.files.get(path);
    return file ? { ...file, bytes: Buffer.from(file.bytes) } : undefined;
  }

  async readCiStatus(signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const ci = this.fixture.ci;
    return ci && typeof ci === "object" && "value" in ci ? (ci as { value: unknown }).value : ci;
  }
}
