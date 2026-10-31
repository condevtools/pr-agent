import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { RuntimeDatabase } from "../postgres/database.js";
import { GitHubInstallationSyncStore } from "../authority/github-installation-sync.js";
import { GitHubInstallationReconciler,
  type GitHubInstallationReconcilerStatus } from "../../integrations/github/onboarding/reconciler.js";
import { GitHubOnboardingProvider } from "../../integrations/github/onboarding/provider.js";
import { processDeferredGitHubPullRequest } from "../../integrations/github/onboarding/deferred-pull-request.js";
import { githubOnboardingPoolConfig, resolveAgentProcessRole, roleStartsWeb } from "./config.js";
import { githubOnboardingEnabled, githubOnboardingRestrictionsEnabled,
  logCore, resolveGitHubOnboardingOrigin } from "#core";
import { incrementMetricCounter } from "../../http/system/metrics-runtime.js";

interface OnboardingResources {
  pool: Pool;
  syncStore: GitHubInstallationSyncStore;
  checked?: Promise<void>;
}
let resources: OnboardingResources | undefined;

interface ReconcilerLifecycleTarget {
  start(): void;
  stop(): Promise<void>;
  readiness(): Readonly<GitHubInstallationReconcilerStatus>;
}

export interface GitHubInstallationReconcilerLifecycleDependencies {
  shouldStart(): boolean;
  create(): Promise<ReconcilerLifecycleTarget>;
}

/** Owns one web-process reconciler and serializes startup against shutdown. */
export class GitHubInstallationReconcilerLifecycle {
  private current?: ReconcilerLifecycleTarget;
  private starting?: Promise<void>;

  constructor(private readonly dependencies: GitHubInstallationReconcilerLifecycleDependencies) {}

  async start(): Promise<void> {
    if (this.current || !this.dependencies.shouldStart()) return;
    this.starting ??= this.createAndStart().finally(() => { this.starting = undefined; });
    await this.starting;
  }

  async stop(): Promise<void> {
    await this.starting;
    const current = this.current;
    this.current = undefined;
    await current?.stop();
  }

  status(): Readonly<GitHubInstallationReconcilerStatus> {
    return this.current?.readiness() ?? { running: false };
  }

  private async createAndStart(): Promise<void> {
    const reconciler = await this.dependencies.create();
    this.current = reconciler;
    reconciler.start();
  }
}

const reconcilerLifecycle = new GitHubInstallationReconcilerLifecycle({
  shouldStart: () => shouldStartGitHubInstallationReconciler(),
  create: async () => {
    const store = await getGitHubInstallationSyncStore();
    const appId = Number(process.env.APP_ID?.trim());
    const reconciler = new GitHubInstallationReconciler({
      store,
      provider: new GitHubOnboardingProvider(),
      origin: resolveGitHubOnboardingOrigin(),
      appId,
      ownerId: `github-installation-sync:${process.pid}:${randomUUID()}`,
      automationEnabled: githubOnboardingEnabled(),
      processDeferred: (claim, signal) => processDeferredGitHubPullRequest(claim, signal, store),
      onActivity: (event) => {
        incrementMetricCounter("pr_agent_github_onboarding_activity_total", { outcome: event.kind });
        if (event.kind === "cleanup_completed") {
          incrementMetricCounter("pr_agent_github_deferred_outcomes_total", { outcome: "expired" }, Number(event.detail?.expired ?? 0));
        }
        if (event.kind === "discovery_completed") {
          incrementMetricCounter("pr_agent_github_onboarding_requests_total", { outcome: "requested" }, Number(event.detail?.requested ?? 0));
          incrementMetricCounter("pr_agent_github_onboarding_requests_total", { outcome: "coalesced" }, Number(event.detail?.coalesced ?? 0));
        }
        logCore("info", `github_installation_sync.${event.kind}`, {
          installationId: event.installationId, ...event.detail,
        });
      },
      onError: (event) => {
        incrementMetricCounter("pr_agent_github_onboarding_errors_total", { operation: event.operation, code: event.code });
        logCore("error", "github_installation_sync.failed", { domainCode: event.code, operation: event.operation,
          installationId: event.installationId, error: event.error });
      },
    });
    return reconciler;
  },
});

export function shouldStartGitHubInstallationReconciler(
  env: NodeJS.ProcessEnv = process.env,
  role = resolveAgentProcessRole(env),
): boolean {
  return roleStartsWeb(role) && githubOnboardingRestrictionsEnabled(env);
}

export async function startGitHubInstallationReconciler(): Promise<void> {
  try {
    await reconcilerLifecycle.start();
    if (reconcilerLifecycle.status().running) {
      logCore("info", "github_installation_sync.started", {
        automationEnabled: githubOnboardingEnabled(),
      });
    }
  } catch (error) {
    await closeGitHubOnboardingStore().catch(() => undefined);
    throw error;
  }
}

export function stopGitHubInstallationReconciler(): Promise<void> {
  return reconcilerLifecycle.stop();
}

export function githubInstallationReconcilerStatus(): Readonly<GitHubInstallationReconcilerStatus> {
  return reconcilerLifecycle.status();
}

export async function getGitHubInstallationSyncStore(): Promise<GitHubInstallationSyncStore> {
  return (await checkedResources()).syncStore;
}

async function checkedResources(): Promise<OnboardingResources> {
  const current: OnboardingResources = resources ??= createResources();
  current.checked ??= assertGitHubOnboardingRole(current.pool).catch((error: unknown) => {
    current.checked = undefined;
    throw error;
  });
  await current.checked;
  return current;
}

export async function closeGitHubOnboardingStore(): Promise<void> {
  await stopGitHubInstallationReconciler();
  const current = resources;
  resources = undefined;
  await current?.pool.end();
}

export async function checkGitHubOnboardingReadiness(): Promise<boolean> {
  try {
    const current = await checkedResources();
    await assertGitHubOnboardingRole(current.pool);
    return true;
  } catch (error) {
    logCore("error", "github_onboarding.readiness_failed", { error });
    return false;
  }
}

function createResources() {
  const pool = new Pool(githubOnboardingPoolConfig());
  pool.on("error", (error) => logCore("error", "github_onboarding.idle_connection_failed", { error }));
  const db = new RuntimeDatabase(pool);
  return { pool, syncStore: new GitHubInstallationSyncStore(db) };
}

const ONBOARDING_FUNCTIONS = [
  "pr_agent_harness.is_harness_admin()",
  "pr_agent_harness.github_onboarding_list(uuid,bigint[])",
  "pr_agent_harness.github_onboarding_enroll(uuid,text,text,text,text,bigint,bigint,bigint,bigint,bigint,text)",
  "pr_agent_harness.github_onboarding_revalidate(uuid,text,text,text,text,bigint,bigint,bigint,bigint,bigint,text,bigint)",
  "pr_agent_harness.github_onboarding_invalidate(bigint,bigint,bigint[],text,text,text)",
  "pr_agent_harness.github_installation_sync_request(bigint,bigint,bigint,text,text,text)",
  "pr_agent_harness.github_installation_restrict_and_request(bigint,bigint,bigint,bigint[],text,text,text)",
  "pr_agent_harness.github_installation_sync_claim(bigint,text,integer)",
  "pr_agent_harness.github_installation_sync_renew(bigint,bigint,text,bigint,bigint,integer)",
  "pr_agent_harness.github_installation_sync_known(bigint)",
  "pr_agent_harness.github_installation_sync_fail(bigint,bigint,text,bigint,bigint,text,timestamptz)",
  "pr_agent_harness.github_installation_snapshot_begin(bigint,bigint,text,bigint,bigint,bigint,bigint,text,timestamptz,bigint[])",
  "pr_agent_harness.github_installation_snapshot_apply_present(bigint,bigint,text,bigint,bigint,text,jsonb)",
  "pr_agent_harness.github_installation_snapshot_absence_candidates(bigint,bigint,text,bigint,bigint,text,bigint[])",
  "pr_agent_harness.github_installation_snapshot_apply_absent(bigint,bigint,text,bigint,bigint,text,bigint[],bigint[])",
  "pr_agent_harness.github_installation_snapshot_complete(bigint,bigint,text,bigint,bigint,text,bigint[])",
  "pr_agent_harness.github_installation_snapshot_complete_restricted(bigint,bigint,text,bigint,bigint,text,text,timestamptz)",
  "pr_agent_harness.github_deferred_pull_request_admit(bigint,bigint,bigint,bigint,text,integer,text,text,text)",
  "pr_agent_harness.github_deferred_pull_request_claim(bigint,text,integer)",
  "pr_agent_harness.github_deferred_pull_request_complete(uuid,text,bigint,text,text,uuid,text,timestamptz)",
  "pr_agent_harness.github_installation_sync_cleanup(integer)",
  "pr_agent_harness.github_installation_sync_status(bigint)",
] as const;

/** Fail startup/readiness on privilege drift, not only missing required grants. */
export async function assertGitHubOnboardingRole(pool: Pool): Promise<void> {
  const result = await pool.query<{ valid: boolean }>(`
    WITH expected AS (
      SELECT to_regprocedure(signature)::oid AS oid FROM unnest($1::text[]) signature
    )
    SELECT current_user='pr_agent_onboarding'
      AND NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls
        OR r.rolinherit OR r.rolreplication)
      AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass
        AND refobjid=r.oid AND deptype='o')
      AND has_schema_privilege(current_user,'pr_agent_harness','USAGE')
      AND NOT has_schema_privilege(current_user,'pr_agent_harness','CREATE')
      AND NOT EXISTS(SELECT 1 FROM expected e WHERE e.oid IS NULL
        OR NOT has_function_privilege(current_user,e.oid,'EXECUTE'))
      AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='pr_agent_harness' AND has_function_privilege(current_user,p.oid,'EXECUTE')
          AND p.prorettype<>'trigger'::regtype
          AND p.oid NOT IN (SELECT oid FROM expected WHERE oid IS NOT NULL))
      AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='pr_agent_harness' AND c.relkind IN ('r','p','v','m','f')
          AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
      AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='pr_agent_harness' AND c.relkind='S'
          AND has_sequence_privilege(current_user,c.oid,'SELECT,UPDATE,USAGE')) AS valid
    FROM pg_roles r WHERE r.rolname=current_user`, [ONBOARDING_FUNCTIONS]);
  if (!result.rows[0]?.valid) throw new Error("GitHub onboarding requires its dedicated restricted PostgreSQL role");
}
