import { hostname } from "node:os";
import { Pool } from "pg";

import { DockerFixVerifier } from "./docker-verifier.js";
import { loadFixPolicyRegistry } from "../proposal/policy.js";
import { PgFixVerifierJobStore } from "./jobs.js";
import { VerifierWorker } from "./worker.js";
import { agentRuntimePoolConfig } from "../../agent-runtime/runtime/config.js";
import { verifierCapabilityHash } from "../../agent-runtime/versions.js";
import { ProcessHeartbeatLoop, ProcessHeartbeatStore } from "../../agent-runtime/runtime/heartbeat.js";

const pool = new Pool(agentRuntimePoolConfig());
pool.on("error", (error) => process.stderr.write(`verifier database connection error: ${error.name}\n`));
const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; current_user: string }>(
  "SELECT rolsuper,rolbypassrls,current_user FROM pg_roles WHERE rolname=current_user",
);
if (!role.rows[0] || role.rows[0].rolsuper || role.rows[0].rolbypassrls || role.rows[0].current_user !== "pr_agent_verifier") {
  throw new Error("verifier requires the dedicated NOSUPERUSER NOBYPASSRLS pr_agent_verifier role");
}
const policies = loadFixPolicyRegistry();
const capabilityHash = await verifierCapabilityHash();
const worker = new VerifierWorker({
  store: new PgFixVerifierJobStore(pool),
  verifier: new DockerFixVerifier(),
  policies,
  owner: `${hostname()}:${process.pid}`,
  verifierCapabilityHash: capabilityHash,
  onError: (error) => process.stderr.write(`verifier worker error: ${error instanceof Error ? error.name : "unknown"}\n`),
});
const processHeartbeat = new ProcessHeartbeatLoop(
  new ProcessHeartbeatStore(pool),
  "verifier",
  { schemaVersion: 1, verifierCapabilityHash: capabilityHash,
    policies: [...policies.values()].map((policy) => ({ id: policy.id, hash: policy.hash,
      nodeImageDigest: policy.nodeImageDigest })) },
  undefined,
  (error) => process.stderr.write(`verifier process heartbeat error: ${error instanceof Error ? error.name : "unknown"}\n`),
);

const shutdown = () => worker.stop();
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
try { await processHeartbeat.start(); await worker.run(); }
finally { await processHeartbeat.stop().catch(() => undefined); await pool.end(); }
