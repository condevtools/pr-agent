import { createHash } from "node:crypto";
import { Pool } from "pg";

import { HarnessDatabase } from "../../src/harness/postgres/database.js";
import { migrateHarness } from "../../src/harness/postgres/migrations.js";
import { ModelBudgetStore, type ModelExecutionPolicy } from "../../src/harness/model-budget-store.js";
import { RunExecutionStore } from "../../src/harness/run-execution-store.js";
import type { ClaimableBinding } from "../../src/harness/run-contracts.js";

// This process is deliberately SIGKILLed by the owning disposable-database test.
const pool = new Pool({ connectionString: process.env.HARNESS_TEST_CHILD_DATABASE_URL, max: 1 });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
process.once("message", async (input: { mode: string; binding: ClaimableBinding;
  runtimeHash: string; policy: ModelExecutionPolicy; providerUrl: string }) => {
  try {
    if (input.mode === "migration") {
      const client = await pool.connect();
      const query = client.query.bind(client);
      // Pause after real migration DDL, before the real migrator's COMMIT.
      client.query = (async (...args: Parameters<typeof client.query>) => {
        const result = await (query as Function)(...args);
        if (typeof args[0] === "string" && args[0].includes("CREATE TABLE pr_agent_harness.agent_runs")) {
          process.send?.({ phase: "migration_uncommitted" });
          await new Promise(() => {});
        }
        return result;
      }) as typeof client.query;
      await migrateHarness({ connect: async () => client } as unknown as Pool);
      throw new Error("Migration fixture should have paused");
    }
    const db = new HarnessDatabase(pool);
    const store = new RunExecutionStore(db);
    const budget = new ModelBudgetStore(db);
    const lease = await store.claim(input.binding, "crash-process", input.runtimeHash);
    if (!lease) throw new Error("Crash fixture could not claim its Run");
    const step = await store.beginStep(lease, { stepKey: "model:crash", kind: "model", inputHash: hash("model-input") });
    const call = await budget.prepare({ lease, stepId: step.id, stepAttemptId: step.attemptId, physicalOrdinal: 1,
      policy: input.policy, intent: { provider: "openai", model: "crash-model", requestKind: "chat-completion",
        requestHash: hash("model-request"), inputTokenUpperBound: 20, maxOutputTokens: 10 } });
    await budget.markDispatched(call, lease);
    const result = await (await fetch(input.providerUrl)).json();
    if (input.mode !== "response_before_commit") {
      await budget.settleKnown({ call, lease, policy: input.policy, result });
      const output = { answer: result.value };
      const state = { next: "complete", completed: [step.id] };
      await store.completeStep(lease, { stepId: step.id, attemptId: step.attemptId,
        output, outputHash: hash(JSON.stringify(output)), checkpoint: { schemaVersion: 1,
          stateHash: hash(JSON.stringify(state)), state } });
      if (input.mode === "terminal_before_ack") {
        await budget.closeRunBudget(lease);
        await store.transition(lease, { to: "succeeded", reasonCode: "fixture_complete", outcomeCode: "artifact_complete" });
      }
    }
    process.send?.({ phase: input.mode, lease, step, callId: call.id });
    await new Promise(() => {});
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : "Crash fixture failed" });
    await pool.end();
    process.exitCode = 1;
    process.disconnect();
  }
});
