import { lstat, opendir, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import type { HarnessDatabase } from "../harness/postgres/database.js";

/** Shared by admission and GC. Provider reads happen before taking this short filesystem/DB lock. */
export async function lockFixSnapshots(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(1768043379, 1)");
}

export async function collectFixSnapshots(input: {
  db: HarnessDatabase; root: string; apply: boolean; olderThanDays?: number; limit?: number;
}): Promise<{ examined: number; eligible: number; removed: number; retained: number }> {
  const days = input.olderThanDays ?? 30;
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid snapshot retention bounds");
  const cutoff = await input.db.trustedTransaction(async (client) => {
    const result = await client.query<{ admin: boolean; cutoff: Date }>(
      `SELECT (rolsuper OR rolbypassrls) AS admin,
         clock_timestamp()-($1::integer*interval '1 day') AS cutoff
       FROM pg_roles WHERE rolname=current_user`, [days]);
    if (!result.rows[0]?.admin) throw new Error("Snapshot retention requires an administrative PostgreSQL role");
    return result.rows[0].cutoff;
  });
  const result = { examined: 0, eligible: 0, removed: 0, retained: 0 };
  let root: string;
  try { root = await realpath(input.root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return result; throw error; }
  for await (const entry of await opendir(root)) {
    if (result.examined >= limit) break;
    const quarantined = /^\.gc-[a-f0-9]{64}-[a-f0-9-]{36}$/.test(entry.name);
    if (!entry.isDirectory() || (!quarantined && !/^[a-f0-9]{64}$/.test(entry.name))) continue;
    result.examined++;
    await input.db.trustedTransaction(async (client) => {
      await lockFixSnapshots(client);
      const directory = join(root,entry.name);
      let info;
      try { info = await lstat(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      if (!info.isDirectory() || info.isSymbolicLink() || info.mtime >= cutoff) { result.retained++; return; }
      if (quarantined) {
        result.eligible++;
        if (input.apply) { await rm(directory,{ recursive: true, force: true }); result.removed++; }
        return;
      }
      // These references include queued intake before source registration, all tenants, and terminal-but-retained Runs.
      const references = await client.query(
        `SELECT 1 FROM pr_agent_harness.agent_runs
         WHERE content_purged_at IS NULL AND input_json #>> '{source,sourceBundleHash}'=$1
         UNION ALL SELECT 1 FROM pr_agent_harness.fix_run_sources
         WHERE source_bundle_hash=$1 AND content_purged_at IS NULL
         UNION ALL SELECT 1 FROM pr_agent_harness.fix_proposals
         WHERE source_bundle_hash=$1 AND content_purged_at IS NULL
         UNION ALL SELECT 1 FROM pr_agent_harness.verification_jobs
         WHERE source_bundle_hash=$1 AND (content_purged_at IS NULL OR status IN ('queued','leased'))
         UNION ALL SELECT 1 FROM pr_agent_harness.fix_proposals p
         JOIN pr_agent_harness.fix_approval_requests a ON a.tenant_id=p.tenant_id AND a.proposal_id=p.id
         LEFT JOIN pr_agent_harness.agent_runs child ON child.tenant_id=a.tenant_id AND child.id=a.approved_publish_run_id
         WHERE p.source_bundle_hash=$1 AND (
           (a.status IN ('open','approved') AND a.expires_at>clock_timestamp())
           OR child.status NOT IN ('succeeded','failed','cancelled'))
         LIMIT 1`, [entry.name]);
      if (references.rowCount) { result.retained++; return; }
      result.eligible++;
      if (!input.apply) return;
      const quarantine = join(root,`.gc-${entry.name}-${randomUUID()}`);
      await rename(directory,quarantine);
      await rm(quarantine,{ recursive: true, force: true });
      result.removed++;
    });
  }
  return result;
}
