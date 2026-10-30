import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveAgentProcessRole } from "../../src/agent-runtime/runtime/config.js";
import { AgentRuntimeComposition } from "../../src/agent-runtime/runtime/composition.js";
import { createWorkflowRegistry, workflowExecutor } from "../../src/agent-runtime/runtime/workflows.js";
import { RunExecutionContractError } from "../../src/agent-runtime/runs/contracts.js";
import { getAgentRuntimeServices, withAgentRuntimeServices } from "../../src/agent-runtime/runtime/services.js";

test("process roles are explicit and all remains the local default", () => {
  assert.equal(resolveAgentProcessRole({}), "all");
  for (const role of ["web", "worker", "recovery", "all"] as const) {
    assert.equal(resolveAgentProcessRole({ PR_AGENT_PROCESS_ROLE: role }), role);
  }
  assert.throws(() => resolveAgentProcessRole({ PR_AGENT_PROCESS_ROLE: "api" }), /web, worker, recovery, or all/);
});

test("composition starts only the loops selected by its process role", async () => {
  class ProbeComposition extends AgentRuntimeComposition {
    workerStarts = 0;
    recoveryStarts = 0;
    override async startWorker() { this.workerStarts += 1; }
    override async startRecovery() { this.recoveryStarts += 1; }
  }
  for (const [role, expected] of [["web", [0, 0]], ["worker", [1, 0]],
    ["recovery", [0, 1]], ["all", [1, 1]]] as const) {
    const probe = new ProbeComposition();
    await probe.start(role);
    assert.deepEqual([probe.workerStarts, probe.recoveryStarts], expected);
  }
});

test("quiesce signals recovery while the worker is still draining", async () => {
  let releaseWorker!: () => void;
  const workerDrain = new Promise<void>((resolve) => { releaseWorker = resolve; });
  const calls: string[] = [];
  class ProbeComposition extends AgentRuntimeComposition {
    override async stopWorker() { calls.push("worker:stop"); await workerDrain; calls.push("worker:drained"); }
    override async stopRecovery() { calls.push("recovery:stop"); }
  }

  const quiescing = new ProbeComposition().quiesce();
  await Promise.resolve();
  assert.deepEqual(calls, ["worker:stop", "recovery:stop"]);
  releaseWorker();
  await quiescing;
  assert.deepEqual(calls, ["worker:stop", "recovery:stop", "worker:drained"]);
});

test("quiesce drains both roles before propagating a stop failure", async () => {
  let releaseRecovery!: () => void;
  const recoveryDrain = new Promise<void>((resolve) => { releaseRecovery = resolve; });
  const calls: string[] = [];
  class ProbeComposition extends AgentRuntimeComposition {
    override async stopWorker() { calls.push("worker:failed"); throw new Error("worker stop failed"); }
    override async stopRecovery() { calls.push("recovery:stop"); await recoveryDrain; calls.push("recovery:drained"); }
  }

  let settled = false;
  const quiescing = new ProbeComposition().quiesce().finally(() => { settled = true; });
  await Promise.resolve();
  assert.deepEqual(calls, ["worker:failed", "recovery:stop"]);
  assert.equal(settled, false);
  releaseRecovery();
  await assert.rejects(quiescing, /worker stop failed/u);
  assert.deepEqual(calls, ["worker:failed", "recovery:stop", "recovery:drained"]);
});

test("workflow registry rejects duplicate and missing executors and fails closed on unknown workflows", async () => {
  const execute = async () => undefined;
  assert.throws(() => createWorkflowRegistry([{ id: "a", execute }, { id: "a", execute }], ["a"]), /Duplicate/);
  assert.throws(() => createWorkflowRegistry([{ id: "a", execute }], ["a", "b"]), /Missing/);
  const dispatch = workflowExecutor(createWorkflowRegistry([{ id: "a", execute }], ["a"]));
  await assert.rejects(dispatch({ input: { workflow: "unknown" } } as never, {} as never), RunExecutionContractError);
});

test("worker workflows inherit the worker-owned service container", async () => {
  const scoped = { marker: "worker-owned" };
  const resolved = await withAgentRuntimeServices(scoped as never, () => getAgentRuntimeServices());
  assert.equal(resolved, scoped);
});

test("runtime leaf modules are acyclic and workflow implementations do not import the composition barrel", async () => {
  const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));
  const runtimeRoot = path.join(sourceRoot, "agent-runtime/runtime");
  const files = (await readdir(runtimeRoot)).filter((name) => name.endsWith(".ts"));
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const source = await readFile(path.join(runtimeRoot, file), "utf8");
    graph.set(file, [...source.matchAll(/from\s+["']\.\/([^"']+)\.js["']/gu)]
      .map((match) => `${match[1]}.ts`).filter((target) => files.includes(target)));
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (file: string) => {
    if (visiting.has(file)) throw new Error(`runtime dependency cycle: ${file}`);
    if (visited.has(file)) return;
    visiting.add(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    visiting.delete(file);
    visited.add(file);
  };
  for (const file of files) visit(file);

  for (const relative of ["review/run.ts", "review/deep/run.ts", "review/platforms/github/workflow.ts",
    "review/platforms/gitlab/workflow.ts", "fix/proposal/run.ts", "fix/publication/workflow.ts",
    "evolution/proposals/run.ts", "evolution/evaluations/run.ts"]) {
    const source = await readFile(path.join(sourceRoot, relative), "utf8");
    assert.doesNotMatch(source, /agent-runtime\/runtime\.js/u, `${relative} must import a runtime leaf`);
  }
  assert.doesNotMatch(await readFile(path.join(sourceRoot, "review/run.ts"), "utf8"), /fix\/proposal/u,
    "review executor must not dispatch Fix workflows");
});
