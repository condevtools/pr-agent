import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { MaintenanceCycleResult, MaintenancePolicy } from "./periodic-store.js";

export interface MaintenanceCycleRunner {
  run(cycleId: string, policy: MaintenancePolicy): Promise<MaintenanceCycleResult>;
}

export class PeriodicMaintenanceLoop {
  private active?: Promise<MaintenanceCycleResult>;

  constructor(
    private readonly runner: MaintenanceCycleRunner,
    private readonly policy: MaintenancePolicy,
    private readonly intervalMs: number,
    private readonly onResult: (result: MaintenanceCycleResult) => void = () => undefined,
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const active = this.runner.run(randomUUID(), this.policy);
      this.active = active;
      try { this.onResult(await active); }
      finally { if (this.active === active) this.active = undefined; }
      if (!signal.aborted) {
        try { await delay(this.intervalMs, undefined, { signal }); }
        catch (error) { if (!signal.aborted) throw error; }
      }
    }
  }

  async stop(): Promise<void> { await this.active; }
}
