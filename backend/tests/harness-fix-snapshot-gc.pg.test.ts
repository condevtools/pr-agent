import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";

import { collectFixSnapshots, lockFixSnapshots } from "../src/fix/snapshot-gc.js";
import { writeSnapshotBundle } from "../src/fix/snapshot-bundle.js";
import { RuntimeDatabase } from "../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../src/agent-runtime/postgres/migrations.js";
import { createRunInTransaction, RunStore } from "../src/agent-runtime/postgres/run-store.js";

const url = process.env.HARNESS_TEST_DATABASE_URL;
if (!url) test.skip("Snapshot GC requires disposable Docker PostgreSQL", () => {});
else test("snapshot retention preserves queued intake references, removes purged content, and never follows symlinks", async () => {
  if (!/^harness_test_/.test(new URL(url).pathname.slice(1))) throw new Error("Disposable database required");
  const pool = new Pool({ connectionString: url });
  const db = new RuntimeDatabase(pool);
  const root = await mkdtemp(join(tmpdir(),"fix-gc-"));
  const outside = await mkdtemp(join(tmpdir(),"fix-gc-external-"));
  try {
    await migrateRuntime(pool);
    const tenantId = randomUUID(); const integrationId = randomUUID();
    const version = "a".repeat(64);
    await new RunStore(db).registerIntegration({ tenantId,id: integrationId,platform: "github",
      origin: "https://api.github.test",repository: `gc/${randomUUID()}` });
    const { bundle,run } = await db.transaction(tenantId,async (client) => {
      await lockFixSnapshots(client);
      const bundle = await writeSnapshotBundle({ root,headSha: "b".repeat(40),dependencyLockHash: version,
        files: [{ path: "source.js",content: Buffer.from("export const privateSource = 1;\n") }] });
      const run = await createRunInTransaction(client,{ tenantId,integrationId,actorType: "service",actorId: "fixture",
        createScope: "fix-gc",createKey: randomUUID(),requestHash: version,runType: "fix.propose.v1",
        baseSha: "a".repeat(40),headSha: "b".repeat(40),workflowVersionHash: version,promptVersionHash: version,
        modelVersionHash: version,toolVersionHash: version,policyVersionHash: version,runtimeVersionHash: version,
        input: { workflow: "fix.propose.v1",source: { sourceBundleHash: bundle.sourceBundleHash } } });
      return { bundle,run };
    });
    const directory = join(root,bundle.sourceBundleHash);
    const old = new Date(Date.now()-60*86_400_000);
    await utimes(directory,old,old);
    await writeFile(join(outside,"keep"),"outside");
    await symlink(outside,join(root,"c".repeat(64)));
    assert.deepEqual(await collectFixSnapshots({db,root,apply:true}),{examined:1,eligible:0,removed:0,retained:1});
    await pool.query("UPDATE pr_agent_harness.agent_runs SET input_json='{}',content_purged_at=clock_timestamp() WHERE id=$1",[run.id]);
    assert.equal((await collectFixSnapshots({db,root,apply:false})).eligible,1);
    assert.equal((await collectFixSnapshots({db,root,apply:true})).removed,1);
    await assert.rejects(stat(directory),{code:"ENOENT"});
    assert.equal((await stat(join(outside,"keep"))).isFile(),true);
  } finally { await pool.end(); await rm(root,{recursive:true,force:true}); await rm(outside,{recursive:true,force:true}); }
});
