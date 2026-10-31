import { createHash } from "node:crypto";

import { RuntimeDatabase } from "../postgres/database.js";
import { normalizeIntegrationTarget } from "../postgres/run-store.js";

const MAX_REPOSITORIES = 10_000;
const BATCH_SIZE = 64;

export interface SyncClaim {
  appId: number;
  installationId: number;
  accountId?: number;
  ownerId: string;
  claimEpoch: number;
  leaseEpoch: number;
  leaseExpiresAt: Date;
}

export interface DeferredPullRequestClaim {
  id: string;
  appId: number;
  installationId: number;
  accountId: number;
  repositoryId: number;
  repository: string;
  pullNumber: number;
  action: DeferredAction;
  deliveryId: string;
  sourceHash: string;
  ownerId: string;
  leaseEpoch: number;
  leaseExpiresAt: Date;
  expiresAt: Date;
}

export interface GitHubInstallationSyncStatus {
  pendingSyncCount: number;
  oldestSyncAgeSeconds?: number;
  pendingDeferredCount: number;
  oldestDeferredAgeSeconds?: number;
  syncConflictCount: number;
  deferredConflictCount: number;
}

type DeferredAction = "opened" | "edited" | "synchronize" | "reopened" | "closed";

interface SyncClaimRow {
  github_app_id: string;
  installation_id: string;
  github_account_id: string | null;
  claim_epoch: string;
  lease_epoch: string;
  lease_expires_at: Date;
}

interface DeferredRow {
  id: string;
  github_app_id: string;
  installation_id: string;
  github_account_id: string;
  repository_id: string;
  repository: string;
  pull_number: number;
  action: DeferredAction;
  delivery_id: string;
  source_hash: string;
  lease_epoch: string;
  lease_expires_at: Date;
  expires_at: Date;
}

export class GitHubInstallationSyncStore {
  constructor(private readonly db: RuntimeDatabase) {}

  async requestSync(input: {
    appId: number;
    installationId: number;
    accountId?: number;
    deliveryId: string;
    eventClass: "positive" | "discovery";
    reason: string;
  }): Promise<{ accepted: boolean; requestedEpoch: number }> {
    const values = syncIdentity(input);
    const deliveryId = requiredText(input.deliveryId, "GitHub delivery identity", 200);
    const reason = requiredText(input.reason, "GitHub sync reason", 200);
    const result = await this.db.trustedTransaction((client) => client.query<{
      accepted: boolean; requested_epoch: string;
    }>(`SELECT * FROM pr_agent_harness.github_installation_sync_request(
      $1,$2,$3,$4,$5,$6)`, [values.appId, values.installationId, values.accountId,
      deliveryId, input.eventClass, reason]));
    return { accepted: result.rows[0]!.accepted,
      requestedEpoch: integer(result.rows[0]!.requested_epoch, "requested epoch") };
  }

  async restrictAndRequest(input: {
    appId: number;
    installationId: number;
    accountId?: number;
    repositoryIds?: number[];
    state: "revoked" | "unknown";
    reason: string;
    deliveryId: string;
  }): Promise<{ accepted: boolean; requestedEpoch: number; changedBindings: number }> {
    const values = syncIdentity(input);
    const repositories = uniquePositiveIds(input.repositoryIds ?? [], "Repository identity");
    if (repositories.length > MAX_REPOSITORIES) throw new Error("Restriction exceeds repository bound");
    const result = await this.db.trustedTransaction((client) => client.query<{
      accepted: boolean; requested_epoch: string; changed_bindings: number;
    }>(`SELECT * FROM pr_agent_harness.github_installation_restrict_and_request(
      $1,$2,$3,$4::bigint[],$5,$6,$7)`, [values.appId, values.installationId, values.accountId,
      repositories.map(String), input.state, requiredText(input.reason, "Restriction reason", 200),
      requiredText(input.deliveryId, "GitHub delivery identity", 200)]));
    const row = result.rows[0]!;
    return { accepted: row.accepted, requestedEpoch: integer(row.requested_epoch, "requested epoch"),
      changedBindings: Number(row.changed_bindings) };
  }

  async claim(input: { appId: number; ownerId: string; leaseSeconds: number }): Promise<SyncClaim | undefined> {
    const appId = positiveId(input.appId, "App identity");
    const ownerId = requiredText(input.ownerId, "Sync owner", 200);
    leaseSeconds(input.leaseSeconds);
    const result = await this.db.trustedTransaction((client) => client.query<SyncClaimRow>(
      "SELECT * FROM pr_agent_harness.github_installation_sync_claim($1,$2,$3)",
      [appId, ownerId, input.leaseSeconds]));
    const row = result.rows[0];
    return row ? mapClaim(row, ownerId) : undefined;
  }

  async renew(claim: SyncClaim, input: { leaseSeconds: number }): Promise<Date> {
    validateClaim(claim);
    leaseSeconds(input.leaseSeconds);
    const result = await this.db.trustedTransaction((client) => client.query<{ renewed_until: Date }>(
      `SELECT pr_agent_harness.github_installation_sync_renew(
        $1,$2,$3,$4,$5,$6) AS renewed_until`,
      [claim.appId, claim.installationId, claim.ownerId, claim.leaseEpoch, claim.claimEpoch,
        input.leaseSeconds]));
    const renewed = new Date(result.rows[0]!.renewed_until);
    claim.leaseExpiresAt = renewed;
    return renewed;
  }

  async fail(claim: SyncClaim, input: { errorCode: string; retryAt: Date }): Promise<boolean> {
    validateClaim(claim);
    validDate(input.retryAt, "Retry time");
    const result = await this.db.trustedTransaction((client) => client.query<{ failed: boolean }>(
      `SELECT pr_agent_harness.github_installation_sync_fail(
        $1,$2,$3,$4,$5,$6,$7) AS failed`,
      [claim.appId, claim.installationId, claim.ownerId, claim.leaseEpoch, claim.claimEpoch,
        requiredText(input.errorCode, "Sync error code", 200), input.retryAt]));
    return result.rows[0]?.failed === true;
  }

  async listKnownInstallations(appId: number): Promise<Array<{ installationId: number; accountId?: number }>> {
    const normalizedAppId = positiveId(appId, "GitHub App identity");
    const result = await this.db.trustedTransaction((client) => client.query<{
      installation_id: string; github_account_id: string | null;
    }>("SELECT * FROM pr_agent_harness.github_installation_sync_known($1)", [normalizedAppId]));
    return result.rows.map((row) => ({ installationId: integer(row.installation_id, "installation identity"),
      ...(row.github_account_id === null ? {} : { accountId: integer(row.github_account_id, "account identity") }) }));
  }

  async discoveryRequests(
    installations: Array<{ appId: number; installationId: number; accountId: number }>,
    discoveryId: string,
    signal?: AbortSignal,
  ): Promise<{ accepted: number; duplicates: number }> {
    const prefix = requiredText(discoveryId, "Discovery identity", 120);
    let accepted = 0;
    for (const installation of installations) {
      signal?.throwIfAborted();
      const result = await this.requestSync({ ...installation,
        deliveryId: `${prefix}:${installation.installationId}`,
        eventClass: "discovery", reason: "complete App installation discovery" });
      if (result.accepted) accepted += 1;
      signal?.throwIfAborted();
    }
    return { accepted, duplicates: installations.length - accepted };
  }

  async applyCompleteSnapshot(claim: SyncClaim, snapshot: {
    accountId: number;
    providerActorId: number;
    completedAt: Date;
    snapshotHash: string;
    repositories: Array<{ id: number; fullName: string }>;
  }, signal?: AbortSignal): Promise<{ tenantId?: string; status: "completed" | "conflict"; created: number;
    restored: number; adopted: number; conflicted: number; revoked: number }> {
    validateClaim(claim);
    const accountId = positiveId(snapshot.accountId, "GitHub account identity");
    const providerActorId = positiveId(snapshot.providerActorId, "Provider actor identity");
    validDate(snapshot.completedAt, "Snapshot completion time");
    if (snapshot.repositories.length > MAX_REPOSITORIES) throw new Error("GitHub snapshot exceeds repository bound");
    const repositories = snapshot.repositories.map((repository) => ({
      id: positiveId(repository.id, "Repository identity"),
      fullName: normalizeIntegrationTarget("github", "https://api.github.com", repository.fullName).repository,
    })).sort((left, right) => left.id - right.id);
    if (new Set(repositories.map(({ id }) => id)).size !== repositories.length
        || new Set(repositories.map(({ fullName }) => fullName)).size !== repositories.length) {
      throw new Error("GitHub snapshot contains duplicate repository identity");
    }
    const presentIds = repositories.map(({ id }) => id);
    const expectedHash = hashGitHubRepositoryIds(presentIds);
    if (snapshot.snapshotHash !== expectedHash) throw new Error("GitHub snapshot hash does not match repository identities");

    signal?.throwIfAborted();
    await this.renew(claim, { leaseSeconds: 60 });
    signal?.throwIfAborted();
    const beginning = await this.db.trustedTransaction((client) => client.query<{
      tenant_id: string | null; mapping_source: string | null; status: "applying" | "conflict";
      known_repository_ids: string[];
    }>(`SELECT * FROM pr_agent_harness.github_installation_snapshot_begin(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::bigint[])`,
    [claim.appId, claim.installationId, claim.ownerId, claim.leaseEpoch, claim.claimEpoch,
      accountId, providerActorId, snapshot.snapshotHash, snapshot.completedAt, presentIds.map(String)]));
    const first = beginning.rows[0]!;
    if (first.status === "conflict") return { status: "conflict", created: 0, restored: 0,
      adopted: 0, conflicted: 0, revoked: 0 };
    signal?.throwIfAborted();

    const totals = { created: 0, restored: 0, adopted: 0, conflicted: 0, revoked: 0 };
    for (let offset = 0; offset < repositories.length; offset += BATCH_SIZE) {
      signal?.throwIfAborted();
      await this.renew(claim, { leaseSeconds: 60 });
      signal?.throwIfAborted();
      const batch = repositories.slice(offset, offset + BATCH_SIZE);
      const result = await this.db.trustedTransaction((client) => client.query<{
        created: number; restored: number; adopted: number; conflicted: number;
      }>(`SELECT * FROM pr_agent_harness.github_installation_snapshot_apply_present(
        $1,$2,$3,$4,$5,$6,$7::jsonb)`, [claim.appId, claim.installationId, claim.ownerId,
        claim.leaseEpoch, claim.claimEpoch, snapshot.snapshotHash, JSON.stringify(batch)]));
      for (const key of ["created", "restored", "adopted", "conflicted"] as const) {
        totals[key] += Number(result.rows[0]![key]);
      }
      signal?.throwIfAborted();
    }
    while (true) {
      signal?.throwIfAborted();
      await this.renew(claim, { leaseSeconds: 60 });
      signal?.throwIfAborted();
      const candidates = await this.db.trustedTransaction((client) => client.query<{ repository_id: string }>(
        `SELECT repository_id FROM pr_agent_harness.github_installation_snapshot_absence_candidates(
          $1,$2,$3,$4,$5,$6,$7::bigint[]) repository_id`,
        [claim.appId, claim.installationId, claim.ownerId, claim.leaseEpoch, claim.claimEpoch,
          snapshot.snapshotHash, presentIds.map(String)]));
      signal?.throwIfAborted();
      if (candidates.rowCount === 0) break;
      const result = await this.db.trustedTransaction((client) => client.query<{ changed: number }>(
        `SELECT pr_agent_harness.github_installation_snapshot_apply_absent(
          $1,$2,$3,$4,$5,$6,$7::bigint[],$8::bigint[]) AS changed`,
        [claim.appId, claim.installationId, claim.ownerId, claim.leaseEpoch, claim.claimEpoch,
          snapshot.snapshotHash, presentIds.map(String), candidates.rows.map(({ repository_id }) => repository_id)]));
      totals.revoked += Number(result.rows[0]!.changed);
      signal?.throwIfAborted();
    }
    signal?.throwIfAborted();
    await this.db.trustedTransaction((client) => client.query(
      `SELECT pr_agent_harness.github_installation_snapshot_complete(
        $1,$2,$3,$4,$5,$6,$7::bigint[])`,
      [claim.appId, claim.installationId, claim.ownerId, claim.leaseEpoch, claim.claimEpoch,
        snapshot.snapshotHash, presentIds.map(String)]));
    return { tenantId: first.tenant_id!,
      status: totals.conflicted > 0 ? "conflict" : "completed", ...totals };
  }

  async completeRestrictedSnapshot(claim: SyncClaim, input: {
    state: "revoked" | "unknown";
    reason: string;
    completedAt: Date;
  }): Promise<{ changedBindings: number }> {
    validateClaim(claim);
    validDate(input.completedAt, "Snapshot completion time");
    const result = await this.db.trustedTransaction((client) => client.query<{ changed: number }>(
      `SELECT pr_agent_harness.github_installation_snapshot_complete_restricted(
        $1,$2,$3,$4,$5,$6,$7,$8) AS changed`, [claim.appId, claim.installationId, claim.ownerId,
        claim.leaseEpoch, claim.claimEpoch, input.state,
        requiredText(input.reason, "Restricted snapshot reason", 200), input.completedAt]));
    return { changedBindings: Number(result.rows[0]!.changed) };
  }

  async defer(input: {
    appId: number; installationId: number; accountId: number; repositoryId: number;
    repository: string; pullNumber: number; action: DeferredAction; deliveryId: string; sourceHash: string;
  }): Promise<{ outcome: "admitted" | "duplicate" | "suppressed"; accepted: boolean; id?: string }> {
    const identity = syncIdentity(input);
    const repositoryId = positiveId(input.repositoryId, "Repository identity");
    const pullNumber = positiveId(input.pullNumber, "Pull request number");
    const repository = normalizeIntegrationTarget("github", "https://api.github.com", input.repository).repository;
    const result = await this.db.trustedTransaction((client) => client.query<{
      outcome: "admitted" | "duplicate" | "suppressed"; id: string | null;
    }>(
      `SELECT * FROM pr_agent_harness.github_deferred_pull_request_admit(
        $1,$2,$3,$4,$5,$6,$7,$8,$9)`, [identity.appId, identity.installationId,
        identity.accountId, repositoryId, repository, pullNumber, input.action,
        requiredText(input.deliveryId, "GitHub delivery identity", 200), hash(input.sourceHash, "Source hash")]));
    const row = result.rows[0]!;
    return { outcome: row.outcome, accepted: row.outcome === "admitted",
      ...(row.id === null ? {} : { id: row.id }) };
  }

  async claimDeferred(input: { appId: number; ownerId: string; leaseSeconds: number }): Promise<DeferredPullRequestClaim | undefined> {
    const appId = positiveId(input.appId, "App identity");
    const ownerId = requiredText(input.ownerId, "Deferred owner", 200);
    leaseSeconds(input.leaseSeconds);
    const result = await this.db.trustedTransaction((client) => client.query<DeferredRow>(
      "SELECT * FROM pr_agent_harness.github_deferred_pull_request_claim($1,$2,$3)",
      [appId, ownerId, input.leaseSeconds]));
    const row = result.rows[0];
    return row ? { id: row.id, appId: integer(row.github_app_id, "app identity"),
      installationId: integer(row.installation_id, "installation identity"),
      accountId: integer(row.github_account_id, "account identity"),
      repositoryId: integer(row.repository_id, "repository identity"), repository: row.repository,
      pullNumber: row.pull_number, action: row.action, deliveryId: row.delivery_id,
      sourceHash: row.source_hash, ownerId, leaseEpoch: integer(row.lease_epoch, "lease epoch"),
      leaseExpiresAt: new Date(row.lease_expires_at), expiresAt: new Date(row.expires_at) } : undefined;
  }

  async completeDeferred(claim: DeferredPullRequestClaim, input: {
    outcome: "completed" | "skipped" | "retry" | "conflict" | "expired";
    runId?: string; errorCode?: string; retryAt?: Date;
  }): Promise<boolean> {
    if (input.outcome === "retry" && !input.retryAt) throw new Error("Deferred retry requires retryAt");
    const result = await this.db.trustedTransaction((client) => client.query<{ completed: boolean }>(
      `SELECT pr_agent_harness.github_deferred_pull_request_complete(
        $1,$2,$3,$4,$5,$6,NULL,$7) AS completed`, [claim.id, claim.ownerId, claim.leaseEpoch,
        input.outcome, input.errorCode ? requiredText(input.errorCode, "Deferred error code", 200) : null,
        input.runId ?? null, input.retryAt ?? null]));
    return result.rows[0]?.completed === true;
  }

  async cleanup(input: { limit?: number } = {}): Promise<{ deleted: number; expired: number }> {
    const limit = input.limit ?? 256;
    if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error("Cleanup limit must be between 1 and 256");
    const result = await this.db.trustedTransaction((client) => client.query<{ deleted: number; expired: number }>(
      "SELECT * FROM pr_agent_harness.github_installation_sync_cleanup($1)", [limit]));
    return { deleted: Number(result.rows[0]!.deleted), expired: Number(result.rows[0]!.expired) };
  }

  async status(appId: number): Promise<GitHubInstallationSyncStatus> {
    const normalizedAppId = positiveId(appId, "GitHub App identity");
    const result = await this.db.trustedTransaction((client) => client.query<{
      pending_sync_count: string; oldest_sync_age_seconds: string | null;
      pending_deferred_count: string; oldest_deferred_age_seconds: string | null;
      sync_conflict_count: string; deferred_conflict_count: string;
    }>("SELECT * FROM pr_agent_harness.github_installation_sync_status($1)", [normalizedAppId]));
    const row = result.rows[0]!;
    return {
      pendingSyncCount: integer(row.pending_sync_count, "pending sync count"),
      ...(row.oldest_sync_age_seconds === null ? {} : {
        oldestSyncAgeSeconds: integer(row.oldest_sync_age_seconds, "oldest sync age"),
      }),
      pendingDeferredCount: integer(row.pending_deferred_count, "pending deferred count"),
      ...(row.oldest_deferred_age_seconds === null ? {} : {
        oldestDeferredAgeSeconds: integer(row.oldest_deferred_age_seconds, "oldest deferred age"),
      }),
      syncConflictCount: integer(row.sync_conflict_count, "sync conflict count"),
      deferredConflictCount: integer(row.deferred_conflict_count, "deferred conflict count"),
    };
  }
}

function syncIdentity(input: { appId: number; installationId: number; accountId?: number }) {
  return { appId: positiveId(input.appId, "GitHub App identity"),
    installationId: positiveId(input.installationId, "Installation identity"),
    accountId: input.accountId === undefined ? null : positiveId(input.accountId, "GitHub account identity") };
}

function validateClaim(claim: SyncClaim): void {
  syncIdentity(claim);
  requiredText(claim.ownerId, "Sync owner", 200);
  positiveId(claim.claimEpoch, "Claim epoch");
  positiveId(claim.leaseEpoch, "Lease epoch");
}

function mapClaim(row: SyncClaimRow, ownerId: string): SyncClaim {
  return { appId: integer(row.github_app_id, "app identity"),
    installationId: integer(row.installation_id, "installation identity"),
    ...(row.github_account_id === null ? {} : { accountId: integer(row.github_account_id, "account identity") }),
    ownerId, claimEpoch: integer(row.claim_epoch, "claim epoch"),
    leaseEpoch: integer(row.lease_epoch, "lease epoch"), leaseExpiresAt: new Date(row.lease_expires_at) };
}

function uniquePositiveIds(values: number[], label: string): number[] {
  return [...new Set(values.map((value) => positiveId(value, label)))];
}

function positiveId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function integer(value: string | number, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is outside the safe integer range`);
  return parsed;
}

function requiredText(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} is invalid`);
  return normalized;
}

function hash(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hash`);
  return value;
}

function leaseSeconds(value: number): void {
  if (!Number.isInteger(value) || value < 5 || value > 300) throw new Error("Lease seconds must be between 5 and 300");
}

function validDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error(`${label} is invalid`);
}

export function hashGitHubRepositoryIds(ids: readonly number[]): string {
  const normalized = [...ids].map((id) => positiveId(id, "Repository identity"))
    .sort((left, right) => left - right);
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("GitHub repository identities must be unique");
  }
  return createHash("sha256").update(normalized.join(",")).digest("hex");
}
