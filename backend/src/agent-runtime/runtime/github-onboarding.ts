import { Pool } from "pg";
import { RuntimeDatabase } from "../postgres/database.js";
import { GitHubOnboardingStore } from "../authority/github-onboarding.js";
import { githubOnboardingPoolConfig } from "./config.js";

let resources: { pool: Pool; store: GitHubOnboardingStore; checked?: Promise<void> } | undefined;

export async function getGitHubOnboardingStore(): Promise<GitHubOnboardingStore> {
  resources ??= createResources();
  resources.checked ??= assertRole(resources.pool).catch((error: unknown) => {
    if (resources) resources.checked = undefined;
    throw error;
  });
  await resources.checked;
  return resources.store;
}

export async function closeGitHubOnboardingStore(): Promise<void> {
  const current = resources;
  resources = undefined;
  await current?.pool.end();
}

export async function checkGitHubOnboardingReadiness(): Promise<boolean> {
  try {
    await getGitHubOnboardingStore();
    await assertRole(resources!.pool);
    return true;
  } catch {
    return false;
  }
}

function createResources() {
  const pool = new Pool(githubOnboardingPoolConfig());
  return { pool, store: new GitHubOnboardingStore(new RuntimeDatabase(pool)) };
}

async function assertRole(pool: Pool): Promise<void> {
  const result = await pool.query<{ valid: boolean }>(`
    SELECT current_user='pr_agent_onboarding'
      AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolbypassrls
      AND NOT has_table_privilege(current_user,'pr_agent_harness.integration_bindings','INSERT,UPDATE,DELETE')
      AND has_function_privilege(current_user,
        'pr_agent_harness.github_onboarding_enroll(uuid,text,text,text,text,bigint,bigint,bigint,bigint,bigint,text)','EXECUTE')
      AND has_function_privilege(current_user,
        'pr_agent_harness.github_onboarding_revalidate(uuid,text,text,text,text,bigint,bigint,bigint,bigint,bigint,text,bigint)','EXECUTE')
      AND has_function_privilege(current_user,
        'pr_agent_harness.github_onboarding_list(uuid,bigint[])','EXECUTE')
      AND has_function_privilege(current_user,
        'pr_agent_harness.github_onboarding_invalidate(bigint,bigint,bigint[],text,text,text)','EXECUTE') AS valid
    FROM pg_roles WHERE rolname=current_user`);
  if (!result.rows[0]?.valid) throw new Error("GitHub onboarding requires its dedicated restricted PostgreSQL role");
}
