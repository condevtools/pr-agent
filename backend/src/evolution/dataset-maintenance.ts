import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { HarnessDatabase } from "../harness/postgres/database.js";

const requestSchema = z.object({ tenantId: z.string().uuid(), datasetId: z.string().uuid() }).strict();

/** Administrative retirement preserves immutable manifests while making raw fixtures unavailable. */
export class EvolutionDatasetMaintenanceStore {
  private readonly db: HarnessDatabase;
  constructor(pool: Pool) { this.db = new HarnessDatabase(pool); }

  async retire(input: { tenantId: string; datasetId: string; expectedVersion: number }): Promise<{ retired: boolean }> {
    const request = requestSchema.extend({ expectedVersion: z.number().int().positive() }).parse(input);
    return this.db.transaction(request.tenantId, async (client) => {
      const actor = await admin(client);
      await lock(client, request.tenantId);
      await assertUnreferenced(client, request);
      const result = await client.query(
        `UPDATE pr_agent_harness.eval_datasets SET status='retired',updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2 AND version=$3 AND status='frozen' RETURNING id`,
        [request.tenantId, request.datasetId, request.expectedVersion]);
      if (!result.rowCount) throw new Error("Dataset retirement requires the current frozen version");
      await audit(client, request, actor, "retire", { expectedVersion: request.expectedVersion });
      return { retired: true };
    });
  }

  async purge(input: { tenantId: string; datasetId: string }): Promise<{ purged: boolean; fixtures: number }> {
    const request = requestSchema.parse(input);
    return this.db.transaction(request.tenantId, async (client) => {
      const actor = await admin(client);
      await lock(client, request.tenantId);
      await assertUnreferenced(client, request);
      const dataset = await client.query<{ status: string; content_purged_at: Date | null }>(
        "SELECT status,content_purged_at FROM pr_agent_harness.eval_datasets WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [request.tenantId, request.datasetId]);
      if (dataset.rows[0]?.status !== "retired") throw new Error("Only retired datasets can be purged");
      if (dataset.rows[0].content_purged_at) return { purged: false, fixtures: 0 };
      const fixtures = await client.query<{ id: string }>(
        `SELECT f.id FROM pr_agent_harness.eval_fixtures f
         WHERE f.tenant_id=$1 AND f.content_purged_at IS NULL
           AND EXISTS (SELECT 1 FROM pr_agent_harness.eval_cases c WHERE c.tenant_id=f.tenant_id AND c.fixture_id=f.id AND c.dataset_id=$2)
           AND NOT EXISTS (SELECT 1 FROM pr_agent_harness.eval_cases c JOIN pr_agent_harness.eval_datasets d
             ON d.tenant_id=c.tenant_id AND d.id=c.dataset_id
             WHERE c.tenant_id=f.tenant_id AND c.fixture_id=f.id AND d.status<>'retired')
         ORDER BY f.id FOR UPDATE OF f`, [request.tenantId, request.datasetId]);
      for (const fixture of fixtures.rows) {
        await client.query(`UPDATE pr_agent_harness.eval_fixture_files SET content_text=NULL,content_purged_at=clock_timestamp()
          WHERE tenant_id=$1 AND fixture_id=$2 AND content_purged_at IS NULL`, [request.tenantId, fixture.id]);
        await client.query(`UPDATE pr_agent_harness.eval_fixtures SET input_json='{"purged":true}'::jsonb,
          ci_json='{"purged":true}'::jsonb,content_purged_at=clock_timestamp()
          WHERE tenant_id=$1 AND id=$2`, [request.tenantId, fixture.id]);
      }
      await client.query(`UPDATE pr_agent_harness.eval_cases SET label_set_json='{"purged":true}'::jsonb,content_purged_at=clock_timestamp()
        WHERE tenant_id=$1 AND dataset_id=$2 AND content_purged_at IS NULL`, [request.tenantId, request.datasetId]);
      await client.query(`UPDATE pr_agent_harness.eval_datasets SET content_purged_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2`, [request.tenantId, request.datasetId]);
      await audit(client, request, actor, "purge", { fixtures: fixtures.rowCount });
      return { purged: true, fixtures: fixtures.rowCount ?? 0 };
    });
  }
}

async function lock(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1830))", [tenantId]);
}
async function assertUnreferenced(client: PoolClient, request: { tenantId: string; datasetId: string }): Promise<void> {
  const references = await client.query<{ referenced: boolean }>(`SELECT
    EXISTS(SELECT 1 FROM pr_agent_harness.evolution_proposal_sources WHERE tenant_id=$1 AND dataset_id=$2)
    OR EXISTS(SELECT 1 FROM pr_agent_harness.evolution_candidates WHERE tenant_id=$1 AND dataset_id=$2)
    OR EXISTS(SELECT 1 FROM pr_agent_harness.eval_runs WHERE tenant_id=$1 AND dataset_id=$2) AS referenced`,
  [request.tenantId, request.datasetId]);
  if (references.rows[0]?.referenced) throw new Error("Dataset has durable proposal or evaluation references");
}
async function admin(client: PoolClient): Promise<string> {
  const result = await client.query<{ allowed: boolean; actor: string }>(
    "SELECT pr_agent_harness.is_harness_admin() AS allowed,current_user AS actor");
  if (!result.rows[0]?.allowed) throw new Error("Dataset maintenance requires an administrative PostgreSQL role");
  return result.rows[0].actor;
}
async function audit(client: PoolClient, request: { tenantId: string; datasetId: string }, actor: string,
  action: string, details: Record<string, unknown>): Promise<void> {
  await client.query(`INSERT INTO pr_agent_harness.audit_logs
    (tenant_id,actor_type,actor_id,action,decision,reason_code,resource_type,resource_ref,details_json)
    VALUES ($1,'database_role',$2,$3,'allowed','retention_policy','eval_dataset',$4,$5::jsonb)`,
    [request.tenantId, actor, `dataset.${action}`, request.datasetId, JSON.stringify(details)]);
}
