import type { PoolClient } from "pg";

import {
  createRunInTransaction,
  type CreateRunInput,
  type CreatedRun,
} from "../../agent-runtime/postgres/run-store.js";

export interface GitHubDeferredRunHandoff {
  ownerId: string;
  leaseEpoch: number;
}

export interface GitHubDeliveryIdentity {
  tenantId: string;
  bindingId: string;
  sourceKey: string;
  sourceHash: string;
}

export class GitHubDeliveryHandoffError extends Error {
  constructor(readonly code: "source_identity_conflict" | "legacy_source_hash_unavailable"
    | "deferred_claim_stale") {
    super(`GitHub delivery handoff failed (${code})`);
    this.name = "GitHubDeliveryHandoffError";
  }
}

export async function createOrReuseGitHubDeliveryRun(
  client: PoolClient,
  identity: GitHubDeliveryIdentity,
  buildCreation: () => Promise<CreateRunInput>,
  deferred?: GitHubDeferredRunHandoff,
): Promise<Pick<CreatedRun, "id" | "created">> {
  if (deferred) await lockDeferred(client, identity, deferred);
  const handoff = await client.query<{ status: "none" | "matching" | "conflict" | "legacy_hash_unavailable";
    run_id: string | null }>(`SELECT * FROM pr_agent_harness.github_delivery_handoff_lock(
      $1::uuid,$2::uuid,$3,$4)`, [identity.tenantId, identity.bindingId,
    identity.sourceKey, identity.sourceHash]);
  const result = handoff.rows[0];
  if (!result) throw new Error("GitHub delivery handoff returned no result");
  if (result.status === "conflict") throw new GitHubDeliveryHandoffError("source_identity_conflict");
  if (result.status === "legacy_hash_unavailable") {
    throw new GitHubDeliveryHandoffError("legacy_source_hash_unavailable");
  }
  if (result.status === "matching") {
    if (!result.run_id) throw new Error("GitHub delivery match has no Run identity");
    if (deferred) await finishDeferred(client, identity, deferred, result.run_id);
    return { id: result.run_id, created: false };
  }

  const creation = await buildCreation();
  assertCreationIdentity(creation, identity);
  const run = await createRunInTransaction(client, creation);
  if (deferred) await finishDeferred(client, identity, deferred, run.id);
  return { id: run.id, created: run.created };
}

async function lockDeferred(
  client: PoolClient,
  identity: GitHubDeliveryIdentity,
  deferred: GitHubDeferredRunHandoff,
): Promise<void> {
  const result = await client.query<{ deferred_id: string | null }>(
    `SELECT pr_agent_harness.github_deferred_pull_request_lock_for_handoff(
      $1::uuid,$2,$3,$4::bigint,$5::uuid) AS deferred_id`,
    [identity.tenantId, identity.sourceKey, deferred.ownerId, deferred.leaseEpoch, identity.bindingId],
  );
  if (!result.rows[0]?.deferred_id) throw new GitHubDeliveryHandoffError("deferred_claim_stale");
}

async function finishDeferred(
  client: PoolClient,
  identity: GitHubDeliveryIdentity,
  deferred: GitHubDeferredRunHandoff,
  runId: string,
): Promise<void> {
  const result = await client.query<{ completed: boolean }>(
    `SELECT pr_agent_harness.github_deferred_pull_request_finish_handoff(
      $1::uuid,$2,$3,$4::bigint,$5::uuid,$6::uuid) AS completed`,
    [identity.tenantId, identity.sourceKey, deferred.ownerId, deferred.leaseEpoch,
      identity.bindingId, runId],
  );
  if (result.rows[0]?.completed !== true) throw new GitHubDeliveryHandoffError("deferred_claim_stale");
}

function assertCreationIdentity(creation: CreateRunInput, identity: GitHubDeliveryIdentity): void {
  if (creation.tenantId !== identity.tenantId || creation.integrationId !== identity.bindingId
      || creation.createKey !== identity.sourceKey
      || creation.sourceIdentity?.kind !== "github_delivery"
      || creation.sourceIdentity.key !== identity.sourceKey
      || creation.sourceIdentity.hash !== identity.sourceHash) {
    throw new Error("GitHub delivery Run creation identity changed after handoff lock");
  }
}
