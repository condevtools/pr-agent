import { hostname } from "node:os";
import { Pool } from "pg";

import { DockerFixVerifier } from "./docker-verifier.js";
import { loadFixPolicyRegistry } from "../proposal/policy.js";
import { PgFixVerifierJobStore } from "./jobs.js";
import { VerifierWorker } from "./worker.js";
import { agentRuntimePoolConfig } from "../../agent-runtime/runtime/config.js";
import { verifierCapabilityHash } from "../../agent-runtime/versions.js";

const pool = new Pool(agentRuntimePoolConfig());
pool.on("error", (error) => process.stderr.write(`verifier database connection error: ${error.name}\n`));
const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; current_user: string }>(
  "SELECT rolsuper,rolbypassrls,current_user FROM pg_roles WHERE rolname=current_user",
);
if (!role.rows[0] || role.rows[0].rolsuper || role.rows[0].rolbypassrls || role.rows[0].current_user !== "pr_agent_verifier") {
  throw new Error("verifier requires the dedicated NOSUPERUSER NOBYPASSRLS pr_agent_verifier role");
}
const policies = loadFixPolicyRegistry();
const worker = new VerifierWorker({
  store: new PgFixVerifierJobStore(pool),
  verifier: new DockerFixVerifier({ snapshotRoot: process.env.FIX_VERIFIER_SNAPSHOT_ROOT ?? "/var/lib/pr-agent-verifier/snapshots" }),
  policies,
  owner: `${hostname()}:${process.pid}`,
  verifierCapabilityHash: await verifierCapabilityHash(),
  onError: (error) => process.stderr.write(`verifier worker error: ${error instanceof Error ? error.name : "unknown"}\n`),
});

const shutdown = () => worker.stop();
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
try { await worker.run(); }
finally { await pool.end(); }
