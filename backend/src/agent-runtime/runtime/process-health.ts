import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type LocalProcessRole = "worker" | "recovery" | "verifier" | "maintenance";
interface ProcessHealthRecord {
  schemaVersion: 1;
  role: LocalProcessRole;
  instanceId: string;
  pid: number;
  heartbeatAt: number;
}

/** One role per container; markers live only in its private tmpfs. */
export class ProcessHealthMarker {
  constructor(
    private readonly role: LocalProcessRole,
    private readonly instanceId: string,
    private readonly directory = process.env.PR_AGENT_HEALTH_DIRECTORY?.trim(),
    private readonly now: () => number = Date.now,
  ) {}

  async record(): Promise<void> {
    if (!this.directory) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${this.role}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const record: ProcessHealthRecord = { schemaVersion: 1, role: this.role,
      instanceId: this.instanceId, pid: process.pid, heartbeatAt: this.now() };
    try {
      await writeFile(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  async clear(): Promise<void> {
    if (!this.directory) return;
    const path = join(this.directory, `${this.role}.json`);
    try {
      const record = await readRecord(path);
      if (record.instanceId === this.instanceId) await rm(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function localProcessIsHealthy(input: {
  role: LocalProcessRole;
  directory: string;
  staleAfterMs: number;
  now?: number;
  isAlive?: (pid: number) => boolean;
}): Promise<boolean> {
  try {
    const record = await readRecord(join(input.directory, `${input.role}.json`));
    const age = (input.now ?? Date.now()) - record.heartbeatAt;
    if (record.role !== input.role || age < 0 || age >= input.staleAfterMs
        || !Number.isSafeInteger(input.staleAfterMs) || input.staleAfterMs <= 0) return false;
    return (input.isAlive ?? processIsAlive)(record.pid);
  } catch { return false; }
}

async function readRecord(path: string): Promise<ProcessHealthRecord> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 2_048) throw new Error("Invalid process health marker");
  const record: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!record || typeof record !== "object") throw new Error("Invalid process health marker");
  const row = record as Record<string, unknown>;
  if (row.schemaVersion !== 1 || !["worker", "recovery", "verifier", "maintenance"].includes(String(row.role))
      || typeof row.instanceId !== "string" || !/^[a-f0-9-]{36}$/u.test(row.instanceId)
      || !Number.isSafeInteger(row.pid) || Number(row.pid) < 1
      || !Number.isSafeInteger(row.heartbeatAt) || Number(row.heartbeatAt) < 1) {
    throw new Error("Invalid process health marker");
  }
  return row as unknown as ProcessHealthRecord;
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
