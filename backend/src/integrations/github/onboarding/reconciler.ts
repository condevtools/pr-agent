import {
  hashGitHubRepositoryIds,
  type DeferredPullRequestClaim,
  type GitHubInstallationSyncStore,
  type SyncClaim,
} from "../../../agent-runtime/authority/github-installation-sync.js";
import {
  GitHubOnboardingAccessError,
  GitHubOnboardingInventoryError,
  type GitHubInstallationDiscovery,
  type GitHubInstallationSnapshot,
  type GitHubOnboardingProvider,
} from "./provider.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_DISCOVERY_INTERVAL_MS = 15 * 60_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 15 * 60_000;
const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_RENEW_INTERVAL_MS = 20_000;
const DEFAULT_PROVIDER_DEADLINE_MS = 5 * 60_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const MAX_RETRY_MS = 5 * 60_000;

export type GitHubInstallationReconcilerStore = Pick<GitHubInstallationSyncStore,
  | "discoveryRequests"
  | "listKnownInstallations"
  | "requestSync"
  | "claim"
  | "renew"
  | "fail"
  | "applyCompleteSnapshot"
  | "completeRestrictedSnapshot"
  | "claimDeferred"
  | "completeDeferred"
  | "cleanup"
>;

export type GitHubInstallationReconcilerProvider = Pick<GitHubOnboardingProvider,
  "discoverInstallations" | "installationSnapshot">;

export interface GitHubInstallationReconcilerStatus {
  running: boolean;
  lastActivityAt?: Date;
  lastDiscoveryAttemptAt?: Date;
  lastDiscoveryCompletedAt?: Date;
  lastCleanupAt?: Date;
  lastErrorCode?: string;
}

export interface GitHubInstallationReconcilerActivity {
  kind: "discovery_completed" | "sync_completed" | "sync_restricted" | "sync_failed"
    | "deferred_completed" | "deferred_failed" | "cleanup_completed" | "sync_claimed" | "deferred_claimed";
  at: Date;
  installationId?: number;
  detail?: Readonly<Record<string, number | string | boolean>>;
}

export interface GitHubInstallationReconcilerError {
  code: string;
  operation: "discovery" | "sync" | "deferred" | "cleanup" | "loop";
  error: unknown;
  installationId?: number;
}

export interface GitHubInstallationReconcilerOptions {
  store: GitHubInstallationReconcilerStore;
  provider: GitHubInstallationReconcilerProvider;
  origin: string;
  appId: number;
  ownerId: string;
  processDeferred(claim: DeferredPullRequestClaim, signal: AbortSignal): Promise<void>;
  repositoryIdsHash?: (ids: readonly number[]) => string;
  onError?: (event: GitHubInstallationReconcilerError) => void;
  onActivity?: (event: GitHubInstallationReconcilerActivity) => void;
  automationEnabled?: boolean;
  pollIntervalMs?: number;
  discoveryIntervalMs?: number;
  cleanupIntervalMs?: number;
  claimLeaseSeconds?: number;
  renewIntervalMs?: number;
  providerDeadlineMs?: number;
  retryBaseMs?: number;
  now?: () => Date;
}

export class GitHubInstallationReconciler {
  private readonly store: GitHubInstallationReconcilerStore;
  private readonly provider: GitHubInstallationReconcilerProvider;
  private readonly origin: string;
  private readonly appId: number;
  private readonly ownerId: string;
  private readonly processDeferred: GitHubInstallationReconcilerOptions["processDeferred"];
  private readonly repositoryIdsHash: (ids: readonly number[]) => string;
  private readonly onError?: GitHubInstallationReconcilerOptions["onError"];
  private readonly onActivity?: GitHubInstallationReconcilerOptions["onActivity"];
  private readonly automationEnabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly discoveryIntervalMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly claimLeaseSeconds: number;
  private readonly renewIntervalMs: number;
  private readonly providerDeadlineMs: number;
  private readonly retryBaseMs: number;
  private readonly now: () => Date;
  private readonly failureCounts = new Map<number, number>();
  private state: GitHubInstallationReconcilerStatus = { running: false };
  private controller?: AbortController;
  private loopPromise?: Promise<void>;
  private iteration?: Promise<void>;
  private nextDiscoveryAt = 0;
  private nextCleanupAt = 0;

  constructor(options: GitHubInstallationReconcilerOptions) {
    this.store = options.store;
    this.provider = options.provider;
    this.origin = requiredText(options.origin, "GitHub origin", 500);
    this.appId = positiveId(options.appId, "GitHub App identity");
    this.ownerId = requiredText(options.ownerId, "GitHub reconciler owner", 200);
    this.processDeferred = options.processDeferred;
    this.repositoryIdsHash = options.repositoryIdsHash ?? hashGitHubRepositoryIds;
    this.onError = options.onError;
    this.onActivity = options.onActivity;
    this.automationEnabled = options.automationEnabled ?? true;
    this.pollIntervalMs = boundedInteger(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 1, 60_000,
      "poll interval");
    this.discoveryIntervalMs = boundedInteger(
      options.discoveryIntervalMs ?? DEFAULT_DISCOVERY_INTERVAL_MS, 1_000, 24 * 60 * 60_000,
      "discovery interval",
    );
    this.cleanupIntervalMs = boundedInteger(
      options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS, 1_000, 24 * 60 * 60_000,
      "cleanup interval",
    );
    this.claimLeaseSeconds = boundedInteger(options.claimLeaseSeconds ?? DEFAULT_LEASE_SECONDS, 5, 300,
      "claim lease");
    this.renewIntervalMs = boundedInteger(options.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS, 1,
      this.claimLeaseSeconds * 1_000 - 1, "lease renewal interval");
    this.providerDeadlineMs = boundedInteger(
      options.providerDeadlineMs ?? DEFAULT_PROVIDER_DEADLINE_MS, 1, 60 * 60_000,
      "provider deadline",
    );
    this.retryBaseMs = boundedInteger(options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS, 1, MAX_RETRY_MS,
      "retry base interval");
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.state.running) return;
    this.controller = new AbortController();
    this.nextDiscoveryAt = 0;
    this.nextCleanupAt = 0;
    this.state = { ...this.state, running: true };
    this.loopPromise = this.loop(this.controller.signal).finally(() => {
      this.state = { ...this.state, running: false };
    });
  }

  async stop(): Promise<void> {
    this.controller?.abort(new DOMException("GitHub installation reconciler stopped", "AbortError"));
    await this.loopPromise;
  }

  readiness(): Readonly<GitHubInstallationReconcilerStatus> {
    return cloneStatus(this.state);
  }

  async discoverNow(signal?: AbortSignal): Promise<void> {
    const operationSignal = signal ?? new AbortController().signal;
    const attemptedAt = this.now();
    this.state = { ...this.state, lastDiscoveryAttemptAt: attemptedAt };
    try {
      const discovery = await this.provider.discoverInstallations(this.origin, {
        signal: operationSignal,
        deadlineMs: this.providerDeadlineMs,
      });
      this.assertDiscoveredApp(discovery);
      const discoveryId = this.discoveryIdentity(attemptedAt);
      const live = discovery.installations.map((installation) => ({
        appId: this.appId,
        installationId: installation.id,
        accountId: installation.account.id,
      }));
      const requested = await this.store.discoveryRequests(live, discoveryId, operationSignal);
      operationSignal.throwIfAborted();
      const liveIds = new Set(live.map(({ installationId }) => installationId));
      const known = await this.store.listKnownInstallations(this.appId);
      let missing = 0;
      for (const installation of known) {
        operationSignal.throwIfAborted();
        if (liveIds.has(installation.installationId)) continue;
        missing += 1;
        await this.store.requestSync({
          appId: this.appId,
          installationId: installation.installationId,
          ...(installation.accountId === undefined ? {} : { accountId: installation.accountId }),
          deliveryId: `${discoveryId}:missing:${installation.installationId}`,
          eventClass: "discovery",
          reason: "installation absent from complete App discovery; confirm current provider state",
        });
      }
      const completedAt = this.now();
      this.state = { ...this.state, lastDiscoveryCompletedAt: completedAt, lastErrorCode: undefined };
      this.activity({ kind: "discovery_completed", at: completedAt,
        detail: { installations: live.length, missing, requested: requested.accepted, coalesced: requested.duplicates } });
    } catch (error) {
      const code = errorCode(error);
      this.recordError({ code, operation: "discovery", error });
      throw error;
    }
  }

  async runOnce(signal?: AbortSignal): Promise<void> {
    if (this.iteration) return await this.iteration;
    const operationSignal = signal ?? new AbortController().signal;
    this.iteration = this.runIteration(operationSignal).finally(() => { this.iteration = undefined; });
    return await this.iteration;
  }

  async cleanupNow(): Promise<void> {
    try {
      const result = await this.store.cleanup({ limit: 256 });
      const at = this.now();
      this.state = { ...this.state, lastCleanupAt: at };
      this.activity({ kind: "cleanup_completed", at, detail: result });
    } catch (error) {
      this.recordError({ code: errorCode(error), operation: "cleanup", error });
      throw error;
    }
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const now = this.now().getTime();
      if (this.automationEnabled && now >= this.nextDiscoveryAt) {
        this.nextDiscoveryAt = now + this.discoveryIntervalMs;
        await this.background("discovery", () => this.discoverNow(signal));
      }
      if (now >= this.nextCleanupAt) {
        this.nextCleanupAt = now + this.cleanupIntervalMs;
        await this.background("cleanup", () => this.cleanupNow());
      }
      if (this.automationEnabled && !signal.aborted) {
        await this.background("loop", () => this.runOnce(signal));
      }
      if (!signal.aborted) {
        try {
          await delay(this.pollIntervalMs, signal);
        } catch (error) {
          if (!signal.aborted) throw error;
        }
      }
    }
  }

  private async runIteration(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const claim = await this.store.claim({ appId: this.appId, ownerId: this.ownerId, leaseSeconds: this.claimLeaseSeconds });
    if (claim) {
      this.activity({ kind: "sync_claimed", at: this.now(), installationId: claim.installationId });
      await this.processSyncClaim(claim, signal);
    }
    if (signal.aborted) return;
    const deferred = await this.store.claimDeferred({ appId: this.appId, ownerId: this.ownerId, leaseSeconds: this.claimLeaseSeconds });
    if (deferred) {
      this.activity({ kind: "deferred_claimed", at: this.now(), installationId: deferred.installationId });
      await this.processDeferredClaim(deferred, signal);
    }
  }

  private async processSyncClaim(claim: SyncClaim, parentSignal: AbortSignal): Promise<void> {
    if (claim.appId !== this.appId) {
      await this.failClaim(claim, "app_identity_mismatch", this.now());
      return;
    }
    const lease = new AbortController();
    let leaseLost = false;
    const signal = AbortSignal.any([parentSignal, lease.signal]);
    const stopRenewal = new AbortController();
    const renewal = this.renewLease(claim, lease, stopRenewal.signal).catch((error: unknown) => {
      leaseLost = true;
      lease.abort(error);
      this.recordError({ code: "lease_lost", operation: "sync", error,
        installationId: claim.installationId });
    });
    try {
      const snapshot = await this.provider.installationSnapshot(this.origin, claim.installationId, {
        signal,
        deadlineMs: this.providerDeadlineMs,
      });
      this.assertSnapshotApp(snapshot);
      if (snapshot.status === "active") {
        const repositories = snapshot.repositories.map((repository) => ({
          id: repository.identity.repositoryId,
          fullName: repository.fullName,
        }));
        const applied = await this.store.applyCompleteSnapshot(claim, {
          accountId: snapshot.account.id,
          providerActorId: snapshot.bot.id,
          completedAt: validDate(snapshot.completedAt),
          snapshotHash: this.repositoryIdsHash(repositories.map(({ id }) => id)),
          repositories,
        }, signal);
        if (applied.status === "conflict" || applied.conflicted > 0) {
          this.recordError({ code: "github_mapping_conflict", operation: "sync",
            error: new Error("GitHub account or repository binding requires operator resolution"),
            installationId: claim.installationId });
          this.activity({ kind: "sync_failed", at: this.now(), installationId: claim.installationId,
            detail: { errorCode: "github_mapping_conflict", repositories: repositories.length } });
          return;
        }
        this.failureCounts.delete(claim.installationId);
        this.activity({ kind: "sync_completed", at: this.now(), installationId: claim.installationId,
          detail: { repositories: repositories.length } });
      } else {
        const state = snapshot.status === "permissions_incomplete" ? "unknown" : "revoked";
        await this.store.completeRestrictedSnapshot(claim, {
          state,
          reason: `provider_snapshot_${snapshot.status}`,
          completedAt: validDate(snapshot.completedAt),
        });
        this.failureCounts.delete(claim.installationId);
        this.activity({ kind: "sync_restricted", at: this.now(), installationId: claim.installationId,
          detail: { state, providerStatus: snapshot.status } });
      }
    } catch (error) {
      if (leaseLost) return;
      const code = parentSignal.aborted ? "coordinator_stopped" : errorCode(error);
      const retryAt = new Date(this.now().getTime() + (parentSignal.aborted ? 0 : this.retryDelay(claim.installationId)));
      await this.failClaim(claim, code, retryAt);
      this.recordError({ code, operation: "sync", error, installationId: claim.installationId });
      this.activity({ kind: "sync_failed", at: this.now(), installationId: claim.installationId,
        detail: { errorCode: code } });
    } finally {
      stopRenewal.abort();
      await renewal;
    }
  }

  private async renewLease(claim: SyncClaim, lease: AbortController, stopSignal: AbortSignal): Promise<void> {
    while (!stopSignal.aborted && !lease.signal.aborted) {
      try {
        await delay(this.renewIntervalMs, AbortSignal.any([stopSignal, lease.signal]));
      } catch (error) {
        if (stopSignal.aborted || lease.signal.aborted) return;
        throw error;
      }
      if (stopSignal.aborted || lease.signal.aborted) return;
      await this.store.renew(claim, { leaseSeconds: this.claimLeaseSeconds });
    }
  }

  private async processDeferredClaim(claim: DeferredPullRequestClaim, signal: AbortSignal): Promise<void> {
    try {
      await this.processDeferred(claim, signal);
      this.activity({ kind: "deferred_completed", at: this.now(), installationId: claim.installationId });
    } catch (error) {
      const code = signal.aborted ? "coordinator_stopped" : errorCode(error);
      await this.store.completeDeferred(claim, {
        outcome: "retry",
        errorCode: code,
        retryAt: new Date(this.now().getTime() + (signal.aborted ? 0 : this.retryBaseMs)),
      });
      this.recordError({ code, operation: "deferred", error, installationId: claim.installationId });
      this.activity({ kind: "deferred_failed", at: this.now(), installationId: claim.installationId,
        detail: { errorCode: code } });
    }
  }

  private async failClaim(claim: SyncClaim, code: string, retryAt: Date): Promise<void> {
    await this.store.fail(claim, { errorCode: code, retryAt });
  }

  private retryDelay(installationId: number): number {
    const failures = (this.failureCounts.get(installationId) ?? 0) + 1;
    this.failureCounts.set(installationId, failures);
    return Math.min(this.retryBaseMs * 2 ** Math.min(failures - 1, 20), MAX_RETRY_MS);
  }

  private assertDiscoveredApp(discovery: GitHubInstallationDiscovery): void {
    if (discovery.app.id !== this.appId
        || discovery.installations.some((installation) => installation.appId !== this.appId)) {
      throw new GitHubOnboardingAccessError("GitHub App discovery identity mismatch");
    }
  }

  private assertSnapshotApp(snapshot: GitHubInstallationSnapshot): void {
    if (snapshot.app.id !== this.appId) {
      throw new GitHubOnboardingAccessError("GitHub App snapshot identity mismatch");
    }
  }

  private discoveryIdentity(at: Date): string {
    return `periodic:${this.appId}:${Math.floor(at.getTime() / this.discoveryIntervalMs)}`;
  }

  private activity(event: GitHubInstallationReconcilerActivity): void {
    this.state = { ...this.state, lastActivityAt: event.at };
    try {
      this.onActivity?.(event);
    } catch {
      // Observability callbacks cannot change claim acknowledgement semantics.
    }
  }

  private recordError(event: GitHubInstallationReconcilerError): void {
    this.state = { ...this.state, lastActivityAt: this.now(), lastErrorCode: event.code };
    try {
      this.onError?.(event);
    } catch {
      // Error reporting must not terminate the coordinator loop.
    }
  }

  private async background(operation: GitHubInstallationReconcilerError["operation"], task: () => Promise<void>) {
    try {
      await task();
    } catch (error) {
      if (operation === "loop" && !isAbort(error)) {
        this.recordError({ code: errorCode(error), operation, error });
      }
    }
  }
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && error.code === "40001") return "stale_claim";
  if (error instanceof GitHubOnboardingInventoryError) {
    if (error.retryable) return "github_api_temporary";
    if (error.status === 403) return "github_api_forbidden";
    if (error.status === 404) return "github_api_not_found";
    return "github_inventory_invalid";
  }
  const status = objectStatus(error);
  if (status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599)) {
    return "github_api_temporary";
  }
  if (status === 403) return "github_api_forbidden";
  if (status === 404) return "github_api_not_found";
  if (error instanceof GitHubOnboardingAccessError) return "github_access_invalid";
  if (isAbort(error)) return "provider_aborted";
  return "github_sync_failed";
}

function objectStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function validDate(value: string): Date {
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error("GitHub snapshot completion time is invalid");
  return result;
}

function cloneStatus(status: GitHubInstallationReconcilerStatus): GitHubInstallationReconcilerStatus {
  return {
    ...status,
    ...(status.lastActivityAt ? { lastActivityAt: new Date(status.lastActivityAt) } : {}),
    ...(status.lastDiscoveryAttemptAt ? { lastDiscoveryAttemptAt: new Date(status.lastDiscoveryAttemptAt) } : {}),
    ...(status.lastDiscoveryCompletedAt
      ? { lastDiscoveryCompletedAt: new Date(status.lastDiscoveryCompletedAt) } : {}),
    ...(status.lastCleanupAt ? { lastCleanupAt: new Date(status.lastCleanupAt) } : {}),
  };
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function positiveId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${label}`);
  return value;
}

function requiredText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${label} is invalid`);
  return normalized;
}
