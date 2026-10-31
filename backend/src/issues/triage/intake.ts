import type { PoolClient } from "pg";
import { resolveUiLocale } from "#core";
import type { PublicationBinding } from "../../agent-runtime/authority/publication-authority.js";
import { getModelExecutionPolicy, reserveRunBudgetInTransaction } from "../../agent-runtime/budget/model-budget-store.js";
import { RunStore, type CreateRunInput } from "../../agent-runtime/postgres/run-store.js";
import { getAgentRuntimeServices } from "../../agent-runtime/runtime/services.js";
import { assertBindingCapability } from "../../agent-runtime/runtime/capabilities.js";
import { AGENT_RUNTIME_CONFIG, runtimeVersionManifest } from "../../agent-runtime/versions.js";
import { resolveModelConfiguration } from "../../model/configuration.js";
import { githubIssueRevision, type GitHubIssueIdentity } from "../../integrations/github/issues/identity.js";
import { issueTriageIdentity, issueTriageRunInputSchema, type IssueTriageRunInput } from "./input.js";

export class IssueTriageRateLimitError extends Error {
  constructor() { super("Issue triage admission limit reached"); this.name = "IssueTriageRateLimitError"; }
}

export async function enqueueIssueTriage(binding: PublicationBinding, issue: GitHubIssueIdentity,
  autoLabels: boolean): Promise<{ id: string; created: boolean }> {
  const input = issueTriageRunInputSchema.parse({ schemaVersion: 1, workflow: "issue.triage.v1", platform: "github",
    target: { origin: binding.origin, repository: binding.repository, providerRepositoryId: binding.providerRepositoryId,
      issueId: issue.id, number: issue.number }, revision: githubIssueRevision(issue), issue,
    options: { autoLabels, locale: resolveUiLocale() } });
  const services = await getAgentRuntimeServices();
  return new RunStore(services.db).createRun(await buildIssueTriageCreation(binding, input));
}

export async function buildIssueTriageCreation(binding: PublicationBinding,
  value: IssueTriageRunInput): Promise<CreateRunInput> {
  const input = issueTriageRunInputSchema.parse(value);
  assertBindingCapability(binding, "issue.triage");
  if (binding.platform !== "github" || binding.state !== "active" || binding.reviewExecutionState !== "active"
      || input.target.origin !== binding.origin || input.target.repository !== binding.repository
      || input.target.providerRepositoryId !== binding.providerRepositoryId
      || input.target.issueId !== input.issue.id || input.target.number !== input.issue.number
      || input.revision !== githubIssueRevision(input.issue)) throw new Error("Issue triage binding or content identity mismatch");
  const identity = issueTriageIdentity(binding.id, input);
  const { provider, model } = resolveModelConfiguration();
  const policy = getModelExecutionPolicy(provider, model);
  return { tenantId: binding.tenantId, integrationId: binding.id,
    actorType: "service", actorId: `integration:${binding.id}`,
    createScope: identity.scope, createKey: identity.key, requestHash: identity.hash,
    runType: input.workflow,
    // These legacy-named generic revision columns contain an Issue content digest, not Git commits.
    baseSha: input.revision, headSha: input.revision, input,
    authorityGeneration: binding.generation, bindingAuthorityVersion: binding.version,
    executionModeGeneration: binding.executionModeGeneration ?? 0,
    ...await runtimeVersionManifest(policy),
    runtimeConfig: { ...AGENT_RUNTIME_CONFIG, workflow: input.workflow, modelPolicy: policy },
    limits: { maxRunMs: AGENT_RUNTIME_CONFIG.maxRunMs, maxJobAttempts: AGENT_RUNTIME_CONFIG.maxJobAttempts,
      maxStepAttempts: AGENT_RUNTIME_CONFIG.maxStepAttempts, model: policy.runLimits },
    admission: async (client, runId) => {
      await admitIssueTriageInTransaction(client, binding, input.issue.user.id);
      await reserveRunBudgetInTransaction(client, { tenantId: binding.tenantId, runId, policy });
    } };
}

/** Called by RunStore only for a new Run. A denial rolls back counters, Run, job and budget together. */
export async function admitIssueTriageInTransaction(client: PoolClient,
  binding: Pick<PublicationBinding, "tenantId" | "id">, authorId: number): Promise<void> {
  if (!Number.isSafeInteger(authorId) || authorId <= 0) throw new Error("Invalid Issue author identity");
  for (const [key, limit] of [["issue-triage:repository", 30], [`issue-triage:author:${authorId}`, 10]] as const) {
    const result = await client.query<{ request_count: number }>(`
      INSERT INTO pr_agent_harness.command_rate_limits
        (tenant_id,integration_id,scope_key,window_started_at,request_count,expires_at)
      VALUES ($1,$2,$3,clock_timestamp(),1,clock_timestamp()+interval '1 hour')
      ON CONFLICT (tenant_id,integration_id,scope_key) DO UPDATE SET
        window_started_at=CASE WHEN command_rate_limits.expires_at<=clock_timestamp()
          THEN clock_timestamp() ELSE command_rate_limits.window_started_at END,
        request_count=CASE WHEN command_rate_limits.expires_at<=clock_timestamp()
          THEN 1 ELSE command_rate_limits.request_count+1 END,
        expires_at=CASE WHEN command_rate_limits.expires_at<=clock_timestamp()
          THEN clock_timestamp()+interval '1 hour' ELSE command_rate_limits.expires_at END,
        updated_at=clock_timestamp()
      RETURNING request_count`, [binding.tenantId, binding.id, key]);
    if (!result.rows[0] || result.rows[0].request_count > limit) throw new IssueTriageRateLimitError();
  }
}
