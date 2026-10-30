import type { VerificationPolicy } from "../contracts.js";
import type { DockerFixVerifier } from "./docker-verifier.js";
import { VerificationJobLeaseLostError, type VerificationJobLease, type PgFixVerifierJobStore } from "./jobs.js";

export interface VerifierWorkerOptions {
  store: PgFixVerifierJobStore;
  verifier: DockerFixVerifier;
  policies: ReadonlyMap<string, VerificationPolicy>;
  owner: string;
  verifierCapabilityHash: string;
  pollMs?: number;
  heartbeatMs?: number;
  sweepMs?: number;
  orphanGraceMs?: number;
  onError?: (error: unknown) => void;
}

/** Dedicated external-tool worker. It owns verifier job leases only, never a Run lease. */
export class VerifierWorker {
  private stopped = false;
  private active?: AbortController;
  private lastSweepAt = 0;

  constructor(private readonly options: VerifierWorkerOptions) {
    if (!options.owner || options.owner.length > 200) throw new Error("invalid verifier worker owner");
  }

  async tick(): Promise<boolean> {
    await this.sweepIfDue();
    const lease = await this.options.store.claim(this.options.owner, this.options.verifierCapabilityHash);
    if (!lease) return false;
    const controller = new AbortController();
    this.active = controller;
    if (this.stopped) controller.abort(new VerifierWorkerStoppingError());
    const heartbeatMs = this.options.heartbeatMs ?? 15_000;
    const heartbeat = setInterval(() => {
      void this.options.store.heartbeat(lease).catch((error) => {
        controller.abort(error);
      });
    }, heartbeatMs);
    heartbeat.unref();
    try {
      if (controller.signal.reason instanceof VerifierWorkerStoppingError) throw controller.signal.reason;
      const policy = this.options.policies.get(lease.proposal.policyId);
      assertFrozenInput(lease, policy);
      const snapshot = await this.options.store.readSnapshot(lease);
      const result = await this.options.verifier.verify(lease.proposal, policy!, {
        jobId: lease.id, owner: lease.owner, epoch: lease.epoch, deadlineAt: lease.deadlineAt,
      }, controller.signal, snapshot);
      if (controller.signal.reason instanceof VerifierWorkerStoppingError) throw controller.signal.reason;
      await this.options.store.complete(lease, result);
    } catch (error) {
      const stopping = controller.signal.reason instanceof VerifierWorkerStoppingError;
      if (stopping) {
        try { await this.options.store.relinquish(lease); }
        catch (failure) { if (!(failure instanceof VerificationJobLeaseLostError)) this.options.onError?.(failure); }
      } else if (!(error instanceof VerificationJobLeaseLostError) && !controller.signal.aborted) {
        try { await this.options.store.fail(lease, safeErrorCode(error)); }
        catch (failure) { if (!(failure instanceof VerificationJobLeaseLostError)) this.options.onError?.(failure); }
      }
      if (!stopping && !(error instanceof VerificationJobLeaseLostError)) this.options.onError?.(error);
    } finally {
      clearInterval(heartbeat);
      if (this.active === controller) this.active = undefined;
    }
    return true;
  }

  async run(): Promise<void> {
    const pollMs = this.options.pollMs ?? 1_000;
    while (!this.stopped) {
      let worked = false;
      try { worked = await this.tick(); }
      catch (error) { this.options.onError?.(error); }
      if (!worked && !this.stopped) await delay(pollMs);
    }
  }

  stop(): void {
    this.stopped = true;
    this.active?.abort(new VerifierWorkerStoppingError());
  }

  private async sweepIfDue(): Promise<void> {
    const sweepMs = this.options.sweepMs ?? 60_000;
    if (Date.now() - this.lastSweepAt < sweepMs) return;
    const now = await this.options.store.databaseNow();
    const result = this.options.verifier.sweepExpiredResources(now, this.options.orphanGraceMs ?? 60_000, 100);
    this.lastSweepAt = Date.now();
    if (result.failures.length) throw new Error(`verifier orphan cleanup failed (${result.failures.length})`);
  }
}

class VerifierWorkerStoppingError extends Error {
  constructor() { super("verifier worker stopping"); this.name = "VerifierWorkerStoppingError"; }
}

function assertFrozenInput(lease: VerificationJobLease, policy: VerificationPolicy | undefined): void {
  if (!policy || policy.hash !== lease.policyHash || policy.nodeImageDigest !== lease.imageDigest
      || policy.dependencyLockPath !== lease.dependencyLockPath
      || policy.dependencyLockHash !== lease.dependencyLockHash
      || policy.sandboxHash !== lease.sandboxPolicyHash) {
    throw new Error("verification_policy_unavailable_or_changed");
  }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_]{1,120}$/i.test(error.message)) return error.message.toLowerCase();
  return error instanceof Error ? error.name.replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 120) : "verification_failed";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
