import type { Pool } from "pg";

import type { AgentProcessRole } from "./config.js";
import { resolveProcessHeartbeatConfiguration, ProcessHeartbeatStore,
  type DurableProcessRole } from "./heartbeat.js";
import { resolveRuntimeCapabilities, type RuntimeCapabilityConfiguration } from "./capabilities.js";
import { verifierCapabilityHash } from "../versions.js";
import { loadFixPolicyRegistry } from "../../fix/proposal/policy.js";
import { resolveWorkerCompatibility, type WorkerCompatibility } from "./worker-compatibility.js";

export interface RuntimeReadinessStatus {
  ok: boolean;
  role: AgentProcessRole;
  capabilities: RuntimeCapabilityConfiguration;
  checks: {
    postgres: boolean;
    runtimeRole: boolean;
    schema: boolean;
    heartbeats: Partial<Record<DurableProcessRole, boolean>>;
  };
}

export async function checkRuntimeReadiness(input: {
  pool: Pool;
  role: AgentProcessRole;
  env?: NodeJS.ProcessEnv;
  workerCompatibility?: WorkerCompatibility;
}): Promise<RuntimeReadinessStatus> {
  const env = input.env ?? process.env;
  const capabilities = resolveRuntimeCapabilities(env);
  const required = requiredHeartbeatRoles(input.role, capabilities);
  const checks: RuntimeReadinessStatus["checks"] = {
    postgres: false,
    runtimeRole: false,
    schema: false,
    heartbeats: Object.fromEntries(required.map((role) => [role, false])),
  };
  try {
    const database = await input.pool.query<{
      safe_role: boolean;
      migration_ledger_ready: boolean;
    }>(
      `SELECT NOT (r.rolsuper OR r.rolbypassrls)
                AND NOT EXISTS (
                  SELECT 1 FROM pg_namespace n
                  WHERE n.nspname='pr_agent_harness'
                    AND (n.nspowner=r.oid OR pg_has_role(r.oid,n.nspowner,'MEMBER'))
                ) AS safe_role,
              to_regclass('pr_agent_harness.schema_migrations') IS NOT NULL AS migration_ledger_ready
       FROM pg_roles r
       WHERE r.rolname=current_user`,
    );
    checks.postgres = true;
    checks.runtimeRole = database.rows[0]?.safe_role === true;
    if (database.rows[0]?.migration_ledger_ready) {
      const schema = await input.pool.query<{ schema_ready: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pr_agent_harness.schema_migrations
           WHERE migration_name='028_runtime_scheduling.sql'
         ) AS schema_ready`,
      );
      checks.schema = schema.rows[0]?.schema_ready === true;
    }
    if (checks.schema) {
      const freshness = await new ProcessHeartbeatStore(input.pool)
        .freshness(resolveProcessHeartbeatConfiguration(env).staleAfterMs);
      checks.heartbeats = Object.fromEntries(required.map((role) => [role, freshness[role].fresh]));
      if (checks.heartbeats.worker) {
        const workerCompatibility = input.workerCompatibility
          ?? await resolveWorkerCompatibility(capabilities, env);
        checks.heartbeats.worker = freshness.worker.capabilityReports.some(
          (report) => workerReportMatches(report, capabilities, workerCompatibility),
        );
      }
      if (capabilities.fix && checks.heartbeats.verifier) {
        checks.heartbeats.verifier = await anyVerifierReportMatches(
          freshness.verifier.capabilityReports,
          env,
        );
      }
    }
  } catch (error) {
    emitReadinessFailure(error);
  }
  return {
    ok: checks.postgres && checks.runtimeRole && checks.schema
      && Object.values(checks.heartbeats).every(Boolean),
    role: input.role,
    capabilities,
    checks,
  };
}

let lastReadinessFailure = "";
let lastReadinessFailureAt = 0;
function emitReadinessFailure(error: unknown): void {
  const reason = error instanceof Error ? error.name : "unknown";
  const candidate = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "") : "";
  const code = /^[A-Z0-9_]{1,32}$/u.test(candidate) ? candidate : "READINESS_CHECK_FAILED";
  const signature = `${reason}:${code}`;
  const now = Date.now();
  if (signature === lastReadinessFailure && now - lastReadinessFailureAt < 60_000) return;
  lastReadinessFailure = signature;
  lastReadinessFailureAt = now;
  process.emitWarning(JSON.stringify({ component: "runtime-readiness", code, reason }));
}

async function anyVerifierReportMatches(
  reports: Record<string, unknown>[],
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const expectedCapabilityHash = await verifierCapabilityHash();
  const policyId = env.FIX_DEFAULT_POLICY_ID?.trim();
  const policy = policyId ? loadFixPolicyRegistry(env.FIX_POLICY_REGISTRY_JSON).get(policyId) : undefined;
  if (!policy) return false;
  return verifierReportsMatch(reports, { verifierCapabilityHash: expectedCapabilityHash,
    policyId: policy.id, policyHash: policy.hash, nodeImageDigest: policy.nodeImageDigest });
}

export function verifierReportsMatch(
  reports: Record<string, unknown>[],
  expected: { verifierCapabilityHash: string; policyId: string; policyHash: string; nodeImageDigest: string },
): boolean {
  return reports.some((report) => report.verifierCapabilityHash === expected.verifierCapabilityHash
    && Array.isArray(report.policies)
    && report.policies.some((candidate) => Boolean(candidate && typeof candidate === "object"
      && (candidate as Record<string, unknown>).id === expected.policyId
      && (candidate as Record<string, unknown>).hash === expected.policyHash
      && (candidate as Record<string, unknown>).nodeImageDigest === expected.nodeImageDigest)));
}

export function workerReportMatches(
  report: Record<string, unknown>,
  expected: RuntimeCapabilityConfiguration,
  compatibility: WorkerCompatibility,
): boolean {
  const capabilities = report.capabilities;
  if (!capabilities || typeof capabilities !== "object") return false;
  const actual = capabilities as Record<string, unknown>;
  const workflows = report.supportedWorkflowIds;
  const expectedWorkflows = compatibility.supportedWorkflowIds;
  return report.schemaVersion === 2
    && report.runtimeVersionHash === compatibility.runtimeVersionHash
    && Array.isArray(workflows)
    && workflows.every((workflow) => typeof workflow === "string")
    && new Set(workflows).size === workflows.length
    && workflows.length === expectedWorkflows.length
    && expectedWorkflows.every((workflow) => workflows.includes(workflow))
    && actual.reviewSingle === true
    && actual.reviewDeep === expected.reviewDeep
    && actual.fix === expected.fix
    && actual.evolution === expected.evolution;
}

export function requiredHeartbeatRoles(
  role: AgentProcessRole,
  capabilities: RuntimeCapabilityConfiguration,
): DurableProcessRole[] {
  const roles: DurableProcessRole[] = role === "worker" ? ["worker"]
    : role === "recovery" ? ["recovery"] : ["worker", "recovery"];
  if (capabilities.fix && role !== "recovery") roles.push("verifier");
  return roles;
}
