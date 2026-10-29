import { executeFixPublicationRun } from "../fix/publish-workflow.js";
import { executeEvolutionProposalRun } from "../evolution/proposal-run.js";
import { executeReplayRun, EvaluationCoordinator } from "../evolution/replay-run.js";
import { EvaluationStore } from "../evolution/replay-store.js";
import { createFixPublicationAdapter } from "../fix/fix-publication-adapter.js";
import { Pool, type PoolConfig } from "pg";
import { createProbot } from "probot";

import { HarnessDatabase } from "./postgres/database.js";
import { normalizeIntegrationTarget, type IntegrationPlatform } from "./postgres/run-store.js";
import { PgPublicationStore, PublicationService, type PublicationScope, type PublicationOperation, type PublicationAdapter } from "./publication.js";
import { PublicationAuthorityStore, validateCredentialRef, type PublicationBinding } from "./authority.js";
import { PublicationBatchCoordinator, PublicationBatchStore } from "./publication-batches.js";
import { createRestBackedOctokit } from "../integrations/github/github-rest-client.js";
import { createGitHubPublicationAdapter } from "../integrations/github/github-publication.js";
import { createGitLabPublicationAdapter } from "../integrations/gitlab/gitlab-publication.js";
import { createPublicationRecoveryLoop, type PublicationRecoveryLoop } from "./recovery.js";
import { isDurablePublicationEnabled } from "./publication-mode.js";
import { verifyGitHubCredentialIdentity } from "./github-credential-identity.js";
import { RunExecutionStore } from "./run-execution-store.js";
import { getModelExecutionPolicy, ModelBudgetStore } from "./model-budget-store.js";
import { ReviewRunWorker } from "./review-run-worker.js";
import type { RunLease } from "./run-contracts.js";
import { executeReviewRun } from "./review-workflow.js";
import { resolveReviewModelConfiguration } from "../review/ai-reviewer.js";
import { reviewVersionManifest } from "./versions.js";
import { PublicationOutcomeCoordinator, PublicationOutcomeHandler } from "./publication-outcome.js";
import { PublicationControlStore } from "./publication-control.js";
export { isDurablePublicationEnabled, requireOnlinePublicationAuthority } from "./publication-mode.js";

export interface PublicationRuntime {
  service: PublicationService;
  scope: Omit<PublicationScope, "target" | "revision">;
  binding: PublicationBinding;
  batchStore: PublicationBatchStore;
  batchCoordinator: PublicationBatchCoordinator;
  createAdapter(operation: PublicationOperation): Promise<PublicationAdapter>;
  resolveCredential(): Promise<string>;
}

let runtime: { pool: Pool; db: HarnessDatabase; service: PublicationService;
  operationStore: PgPublicationStore; authority: PublicationAuthorityStore;
  batchStore: PublicationBatchStore; batchCoordinator: PublicationBatchCoordinator } | undefined;
let runWorker: ReviewRunWorker | undefined;
let roleCheck: Promise<void> | undefined;
let credentialApp: ReturnType<typeof createProbot> | undefined;
let credentialAppOrigin: string | undefined;
let recovery: PublicationRecoveryLoop | undefined;
/** Explicit harness configuration only; never fall back to an unrelated DATABASE_URL. */
export function harnessPoolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const connectionString = env.HARNESS_DATABASE_URL?.trim();
  const common = { max: 8, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000,
    statement_timeout: 15_000, lock_timeout: 5_000, idle_in_transaction_session_timeout: 15_000 };
  if (connectionString) return { ...common, connectionString };
  const host = env.HARNESS_PG_HOST?.trim();
  const database = env.HARNESS_PG_DATABASE?.trim();
  const user = env.HARNESS_PG_USER?.trim();
  const password = env.HARNESS_PG_PASSWORD;
  const port = Number(env.HARNESS_PG_PORT || "5432");
  if (!host || !database || !user || !password || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Configure HARNESS_DATABASE_URL or HARNESS_PG_HOST/DATABASE/USER/PASSWORD/PORT");
  }
  return { ...common, host, database, user, password, port };
}

export async function resolvePublicationRuntime(input: {
  platform: IntegrationPlatform;
  origin: string;
  repository: string;
}): Promise<PublicationRuntime | undefined> {
  if (!isDurablePublicationEnabled()) return undefined;
  const current = await getHarnessServices();
  const binding = await current.authority.resolve(input.platform, input.origin, input.repository);
  return publicationRuntimeForBinding(binding, current);
}

export async function getHarnessServices() {
  if (!runtime) {
    const pool = new Pool(harnessPoolConfig());
    // An idle connection failure must not leak the connection string or crash via an unhandled event.
    pool.on("error", () => process.emitWarning("Harness PostgreSQL idle connection failed"));
    const db = new HarnessDatabase(pool);
    const operationStore = new PgPublicationStore(db);
    const service = new PublicationService(operationStore);
    const batchStore = new PublicationBatchStore(db);
    runtime = { pool, db, operationStore, service,
      authority: new PublicationAuthorityStore(db), batchStore,
      batchCoordinator: new PublicationBatchCoordinator(batchStore, service) };
  }
  const current = runtime;
  roleCheck ??= current.pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  ).then((result) => {
    const role = result.rows[0];
    if (!role || role.rolsuper || role.rolbypassrls) {
      throw new Error("Harness runtime requires a NOSUPERUSER NOBYPASSRLS PostgreSQL role");
    }
  }).catch((error: unknown) => { roleCheck = undefined; throw error; });
  await roleCheck;
  return current;
}

export async function publicationRuntimeForBinding(
  binding: PublicationBinding,
  services?: Awaited<ReturnType<typeof getHarnessServices>>,
): Promise<PublicationRuntime> {
  const current = services ?? await getHarnessServices();
  return {
    service: current.service,
    scope: { tenantId: binding.tenantId, integrationId: binding.id, platform: binding.platform,
      origin: binding.origin, repository: binding.repository, authorityGeneration: binding.generation },
    binding, batchStore: current.batchStore, batchCoordinator: current.batchCoordinator,
    resolveCredential: () => resolvePublicationCredential(binding),
    createAdapter: async (operation) => {
      if (operation.scope.tenantId !== binding.tenantId || operation.scope.integrationId !== binding.id
          || operation.scope.authorityGeneration !== binding.generation) throw new Error("Publication gateway scope mismatch");
      const credential = await resolvePublicationCredential(binding);
      if (binding.platform === "gitlab") {
        if (operation.operationType && operation.operationType !== "publication") {
          return createFixPublicationAdapter({ binding, token: credential, operation });
        }
        return createGitLabPublicationAdapter({ binding: { ...binding, platform: "gitlab" }, token: credential, operation });
      }
      const octokit = createRestBackedOctokit({ token: credential, baseUrl: binding.origin });
      const verifyCredentialIdentity = () => verifyGitHubCredentialIdentity({
        credentialRef: binding.credentialRef, octokit,
        loadAppIdentity: async (installationId: number) => {
          const appClient = await getCredentialApp(binding).auth();
          const { data: app } = await appClient.request("GET /app");
          if (!app) throw new Error("GitHub App identity is unavailable");
          const { data: installation } = await appClient.request("GET /app/installations/{installation_id}", {
            installation_id: installationId,
          });
          return { app, installation };
        },
      });
      if (operation.operationType && operation.operationType !== "publication") {
        return createFixPublicationAdapter({ binding, token: credential, operation, verifyCredentialIdentity });
      }
      return createGitHubPublicationAdapter({ binding: { ...binding, platform: "github" }, octokit, operation,
        verifyCredentialIdentity });
    },
  };
}

async function resolvePublicationCredential(binding: PublicationBinding): Promise<string> {
  validatePublicationCredentialOrigin(binding);
  validateCredentialRef(binding.credentialRef);
  if (binding.credentialRef.startsWith("github-app:")) {
    if (binding.platform !== "github") throw new Error("GitHub installation credential cannot authorize a GitLab binding");
    const installationId = Number(binding.credentialRef.slice("github-app:".length));
    if (!Number.isSafeInteger(installationId)) throw new Error("Invalid GitHub installation identity");
    const octokit = await getCredentialApp(binding).auth(installationId);
    const auth = await octokit.auth({ type: "installation" }) as { token?: unknown };
    if (typeof auth.token !== "string" || !auth.token) throw new Error("GitHub installation credential is unavailable");
    return auth.token;
  }
  const name = binding.credentialRef.slice("env:".length);
  if ((binding.platform === "gitlab") !== (name === "GITLAB_TOKEN")) throw new Error("Credential platform mismatch");
  const token = process.env[name]?.trim();
  if (!token) throw new Error("Server publication credential is unavailable");
  return token;
}

function getCredentialApp(binding: PublicationBinding): ReturnType<typeof createProbot> {
  validatePublicationCredentialOrigin(binding);
  if (credentialAppOrigin && credentialAppOrigin !== binding.origin) {
    throw new Error("GitHub App credential destination changed during runtime");
  }
  if (!credentialApp) {
    credentialApp = createProbot({ overrides: { baseUrl: binding.origin } });
    credentialAppOrigin = binding.origin;
  }
  return credentialApp;
}

export function validatePublicationCredentialOrigin(
  binding: Pick<PublicationBinding, "platform" | "origin" | "repository">,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const configured = binding.platform === "github"
    ? env.GITHUB_API_URL?.trim() || "https://api.github.com"
    : env.GITLAB_BASE_URL?.trim() || "https://gitlab.com";
  const expected = normalizeIntegrationTarget(binding.platform, configured, binding.repository).origin;
  if (binding.origin !== expected) throw new Error("Publication binding origin does not match the configured credential destination");
}

export async function startHarnessRecovery(): Promise<void> {
  if (!isDurablePublicationEnabled() || recovery) return;
  const services = await getHarnessServices();
  recovery = createPublicationRecoveryLoop({
    db: services.db, authority: services.authority,
    batchStore: services.batchStore, batchCoordinator: services.batchCoordinator,
    runtimeForBinding: (binding) => publicationRuntimeForBinding(binding, services),
    onError: (error, context) => {
      // Record the operation and failure class, never credentials/provider response bodies.
      process.emitWarning(JSON.stringify({ component: "publication-recovery", ...context,
        errorType: error instanceof Error ? error.name : "unknown" }));
    },
  });
  recovery.start();
}

export async function stopHarnessRecovery(): Promise<void> {
  const previous = recovery;
  recovery = undefined;
  await previous?.stop();
}

export async function startReviewRunWorker(): Promise<void> {
  if (!isDurablePublicationEnabled() || runWorker) return;
  const services = await getHarnessServices();
  const store = new RunExecutionStore(services.db);
  const budget = new ModelBudgetStore(services.db);
  const outcomes = new PublicationOutcomeCoordinator({ db: services.db, batchStore: services.batchStore });
  const evaluations = new EvaluationCoordinator(new EvaluationStore(services.db));
  const outcomeHandler = new PublicationOutcomeHandler({
    store, budget, batchStore: services.batchStore, batchCoordinator: services.batchCoordinator,
    control: new PublicationControlStore(services.db),
    createAdapter: async (operation) => {
      const binding = await services.authority.get(operation.scope.tenantId, operation.scope.integrationId);
      return (await publicationRuntimeForBinding(binding, services)).createAdapter(operation);
    },
  });
  runWorker = new ReviewRunWorker({
    store, budget, outcomeHandler, coordinateOutcomes: async (binding) => {
      const results = await Promise.allSettled([outcomes.tick(binding), evaluations.tick(binding)]);
      for (const result of results) if (result.status === "rejected") {
        process.emitWarning(JSON.stringify({ component: "harness-coordinator",
          errorType: result.reason instanceof Error ? result.reason.name : "unknown" }));
      }
    },
    bindings: () => services.authority.listRecoverable(),
    runtimeHash: async () => {
      const { provider, model } = resolveReviewModelConfiguration();
      return (await reviewVersionManifest(getModelExecutionPolicy(provider, model))).runtimeVersionHash;
    },
    execute: executeHarnessRun,
    onError: (error, runId) => process.emitWarning(JSON.stringify({ component: "review-run-worker", runId,
      errorType: error instanceof Error ? error.name : "unknown" })),
  });
  runWorker.start();
}

export function executeHarnessRun(lease: RunLease, binding: PublicationBinding): Promise<void> {
  if (lease.input.workflow === "fix.publish.v1") return executeFixPublicationRun(lease, binding);
  if (lease.input.workflow === "evolution.propose.v1") return executeEvolutionProposalRun(lease);
  if (lease.input.workflow === "eval.replay.v1") return executeReplayRun(lease, binding);
  return executeReviewRun(lease, binding);
}

export async function stopReviewRunWorker(): Promise<void> {
  const previous = runWorker;
  runWorker = undefined;
  await previous?.stop();
}

export async function closeHarnessRuntime(): Promise<void> {
  await stopReviewRunWorker();
  await stopHarnessRecovery();
  const previous = runtime;
  runtime = undefined;
  roleCheck = undefined;
  credentialApp = undefined;
  credentialAppOrigin = undefined;
  await previous?.pool.end();
}
