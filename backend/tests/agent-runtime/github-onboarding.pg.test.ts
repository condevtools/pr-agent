import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { Pool } from "pg";

import { GitHubOnboardingStore, type GitHubOnboardingIdentity } from
  "../../src/agent-runtime/authority/github-onboarding.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RunStore } from "../../src/agent-runtime/postgres/run-store.js";
import {
  buildPublicationIdentity,
  preparePublicationInTransaction,
} from "../../src/agent-runtime/publication/publication.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test.skip("GitHub onboarding tests require isolated Docker HARNESS_TEST_DATABASE_URL");
} else {
  if (!decodeURIComponent(new URL(databaseUrl).pathname.slice(1)).startsWith("harness_test_")) {
    throw new Error("Disposable harness_test_* database required");
  }
  const admin = new Pool({ connectionString: databaseUrl });
  const password = randomUUID();
  const nonOnboardingPasswords = {
    pr_agent_app: "app-test-only",
    pr_agent_verifier: "verifier-test-only",
    pr_agent_maintenance: "maintenance-test-only",
  } as const;
  let onboardingPool: Pool;
  let onboarding: GitHubOnboardingStore;

  before(async () => {
    for (const [role, rolePassword] of [
      ...Object.entries(nonOnboardingPasswords),
      ["pr_agent_onboarding", password],
    ]) {
      const exists = await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]);
      const ddl = await admin.query<{ sql: string }>(exists.rowCount
        ? "SELECT format('ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',$1::text,$2::text) AS sql"
        : "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',$1::text,$2::text) AS sql",
      [role, rolePassword]);
      await admin.query(ddl.rows[0]!.sql);
    }
    await migrateRuntime(admin);
    const restrictedUrl = new URL(databaseUrl);
    restrictedUrl.username = "pr_agent_onboarding";
    restrictedUrl.password = password;
    onboardingPool = new Pool({ connectionString: restrictedUrl.toString(), max: 6 });
    onboarding = new GitHubOnboardingStore(new RuntimeDatabase(onboardingPool));
  });

  after(async () => {
    await onboardingPool?.end();
    await admin.query("DROP SCHEMA pr_agent_harness CASCADE");
    await admin.end();
  });

  test("dedicated onboarding role has only narrow function authority", async () => {
    const role = await onboardingPool.query<{
      rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolbypassrls: boolean;
    }>("SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user");
    assert.deepEqual(role.rows[0], {
      rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false,
    });
    await assert.rejects(
      onboardingPool.query("SELECT * FROM pr_agent_harness.integration_bindings"),
      /permission denied/,
    );
    await assert.rejects(
      onboardingPool.query("INSERT INTO pr_agent_harness.integration_bindings(id,tenant_id,platform,origin,repository) VALUES ($1,$2,'github','https://api.github.com','denied/repo')",
        [randomUUID(), randomUUID()]),
      /permission denied/,
    );

    const directEnroll = `SELECT * FROM pr_agent_harness.github_onboarding_enroll(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;
    const directArgs = [randomUUID(), "user", "test-admin", "https://api.github.com",
      "example/denied", 11, 12, 13, 14, 15, "explicit test confirmation"];
    for (const [roleName, rolePassword] of Object.entries(nonOnboardingPasswords)) {
      const roleUrl = new URL(databaseUrl);
      roleUrl.username = roleName;
      roleUrl.password = rolePassword;
      const rolePool = new Pool({ connectionString: roleUrl.toString(), max: 1 });
      try {
        await assert.rejects(rolePool.query(directEnroll, directArgs), (error: unknown) =>
          isPgError(error, "42501", /permission denied for function github_onboarding_enroll/u));
      } finally {
        await rolePool.end();
      }
    }
  });

  test("onboarding functions require caller-established tenant scope and reject direct SQL nulls", async () => {
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const identity = githubIdentity("example/scoped", 100);
    await rejectsInTransaction(
      "SELECT * FROM pr_agent_harness.github_onboarding_list($1,ARRAY[]::bigint[])",
      [tenantId], "42501", /tenant scope mismatch/u,
    );
    await rejectsInTransaction(
      "SELECT * FROM pr_agent_harness.github_onboarding_list(NULL,ARRAY[]::bigint[])",
      [], "42501", /tenant scope mismatch/u, tenantId,
    );
    await rejectsInTransaction(
      "SELECT * FROM pr_agent_harness.github_onboarding_list($1,ARRAY[]::bigint[])",
      [otherTenantId], "42501", /tenant scope mismatch/u, tenantId,
    );
    await rejectsInTransaction(
      "SELECT * FROM pr_agent_harness.github_onboarding_list($1,NULL::bigint[])",
      [tenantId], "22023", /installation scope/u, tenantId,
    );
    await rejectsInTransaction(
      `SELECT * FROM pr_agent_harness.github_onboarding_enroll(
        $1,'user','test-admin',$2,$3,NULL,$4,$5,$6,$7,'explicit confirmation')`,
      [tenantId, identity.origin, identity.repository, identity.installationId,
        identity.accountId, identity.repositoryId, identity.actorId],
      "22023", /invalid GitHub onboarding request/u, tenantId,
    );
    await rejectsInTransaction(
      `SELECT * FROM pr_agent_harness.github_onboarding_revalidate(
        $1,'user','test-admin',$2,$3,$4,$5,$6,$7,$8,'explicit confirmation',NULL)`,
      [tenantId, identity.origin, identity.repository, identity.appId,
        identity.installationId, identity.accountId, identity.repositoryId, identity.actorId],
      "22023", /invalid GitHub revalidation request/u, tenantId,
    );
    assert.equal(await bindingCount(), 0);
  });

  test("fresh enrollment is atomic and concurrent retries adopt one active binding", async () => {
    const tenantId = randomUUID();
    const identity = githubIdentity("example/onboarding", 101);
    const input = administrativeInput(tenantId, identity);
    const bindings = await Promise.all(Array.from({ length: 6 }, () => onboarding.enroll(input)));
    assert.equal(new Set(bindings.map(({ id }) => id)).size, 1);
    assert.equal(bindings[0]!.state, "active");
    assert.equal(bindings[0]!.generation, 1);
    assert.equal(bindings[0]!.version, 2);
    assert.equal(bindings[0]!.providerAccessState, "verified");
    assert.equal(bindings[0]!.providerAccessVersion, 0);
    assert.equal(bindings[0]!.githubAppId, identity.appId);
    assert.equal(bindings[0]!.githubAccountId, identity.accountId);
    const count = await admin.query<{ count: string }>(
      "SELECT count(*) FROM pr_agent_harness.integration_bindings WHERE provider_repository_id=$1",
      [String(identity.repositoryId)],
    );
    assert.equal(count.rows[0]!.count, "1");
    const listed = await onboarding.list(tenantId, []);
    assert.deepEqual(listed.map(({ id }) => id), [bindings[0]!.id]);
    assert.deepEqual(await onboarding.list(tenantId, [identity.installationId + 1]), []);
  });

  test("provider identity cannot cross tenant ownership and invalid input leaves no row", async () => {
    const identity = githubIdentity("example/owned", 102);
    await onboarding.enroll(administrativeInput(randomUUID(), identity));
    await assert.rejects(
      onboarding.enroll(administrativeInput(randomUUID(), identity)),
      /conflicts with an existing binding/,
    );
    const beforeCount = await bindingCount();
    await assert.rejects(
      onboarding.enroll(administrativeInput(randomUUID(), { ...githubIdentity("bad/repo", 103), actorId: 0 })),
      /positive safe integer/,
    );
    assert.equal(await bindingCount(), beforeCount);
  });

  test("active repository rename requires explicit revalidation", async () => {
    const tenantId = randomUUID();
    const identity = githubIdentity("example/original-name", 1031);
    const active = await onboarding.enroll(administrativeInput(tenantId, identity));
    const renamed = { ...identity, repository: "example/renamed-repository" };
    await assert.rejects(
      onboarding.enroll(administrativeInput(tenantId, renamed)),
      /repository rename requires explicit revalidation/u,
    );
    assert.equal((await onboarding.list(tenantId, []))[0]!.repository, identity.repository);
    const revalidated = await onboarding.revalidate({
      ...administrativeInput(tenantId, renamed),
      expectedAccessVersion: active.providerAccessVersion,
    });
    assert.equal(revalidated.repository, renamed.repository);
    assert.equal(revalidated.generation, active.generation + 1);
  });

  test("manual blocked bindings are returned without configuration or activation", async () => {
    const tenantId = randomUUID();
    const id = randomUUID();
    const identity = githubIdentity("example/manual", 104);
    await new RunStore(new RuntimeDatabase(admin)).registerIntegration({
      tenantId, id, platform: "github", origin: identity.origin, repository: identity.repository,
    });
    const result = await onboarding.enroll(administrativeInput(tenantId, identity));
    assert.equal(result.id, id);
    assert.equal(result.state, "blocked");
    assert.equal(result.generation, 0);
    const stored = await admin.query<{
      provider_repository_id: string | null; credential_ref: string | null;
    }>("SELECT provider_repository_id,credential_ref FROM pr_agent_harness.integration_bindings WHERE id=$1", [id]);
    assert.deepEqual(stored.rows[0], { provider_repository_id: null, credential_ref: null });
  });

  test("lifecycle invalidation is monotone and revalidation fences the prior generation", async () => {
    const tenantId = randomUUID();
    const identity = githubIdentity("example/revoked", 105);
    const active = await onboarding.enroll(administrativeInput(tenantId, identity));
    assert.equal(await onboarding.invalidate({
      appId: identity.appId, installationId: identity.installationId,
      repositoryIds: [identity.repositoryId], state: "unknown",
      reason: "repository inventory requires reconciliation", deliveryId: "delivery-unknown-105",
    }), 1);
    assert.equal(await onboarding.invalidate({
      appId: identity.appId, installationId: identity.installationId,
      repositoryIds: [identity.repositoryId], state: "revoked",
      reason: "repository access removed", deliveryId: "delivery-revoked-105",
    }), 1);
    assert.equal(await onboarding.invalidate({
      appId: identity.appId, installationId: identity.installationId,
      repositoryIds: [identity.repositoryId], state: "unknown",
      reason: "stale event", deliveryId: "delivery-stale-105",
    }), 1);
    assert.equal(await onboarding.invalidate({
      appId: identity.appId, installationId: identity.installationId,
      repositoryIds: [identity.repositoryId], state: "revoked",
      reason: "duplicate delivery", deliveryId: "delivery-revoked-105",
    }), 0);
    const revoked = (await onboarding.list(tenantId, []))[0]!;
    assert.equal(revoked.providerAccessState, "revoked");
    assert.equal(revoked.providerAccessVersion, 3);
    assert.equal(revoked.providerAccessReason, "repository access removed");
    assert.equal(await onboarding.invalidate({
      appId: identity.appId, installationId: identity.installationId,
      repositoryIds: [identity.repositoryId], state: "revoked",
      reason: "new restrictive delivery after live verification",
      deliveryId: "delivery-revoked-after-verify-105",
    }), 1);
    await assert.rejects(onboarding.revalidate({
      ...administrativeInput(tenantId, identity), expectedAccessVersion: revoked.providerAccessVersion,
    }), /version conflict/u);
    const currentRevoked = (await onboarding.list(tenantId, []))[0]!;
    assert.equal(currentRevoked.providerAccessState, "revoked");
    assert.equal(currentRevoked.providerAccessVersion, 4);
    assert.equal(currentRevoked.providerAccessReason, "repository access removed");
    const rotatedIdentity = { ...identity, installationId: identity.installationId + 10_000 };
    await assert.rejects(
      onboarding.enroll(administrativeInput(tenantId, rotatedIdentity)),
      /conflicts with an existing binding/u,
    );
    const authority = await admin.query<{ publication: boolean; execution: boolean }>(
      `SELECT
        pr_agent_harness.lock_active_publication_authority($1,$2,'github',$3,$4,$5) AS publication,
        pr_agent_harness.lock_active_review_execution_authority($1,$2,$5,1) AS execution`,
      [tenantId, active.id, identity.origin, identity.repository, active.generation],
    );
    assert.deepEqual(authority.rows[0], { publication: false, execution: false });
    const restored = await onboarding.revalidate({
      ...administrativeInput(tenantId, rotatedIdentity), expectedAccessVersion: currentRevoked.providerAccessVersion,
    });
    assert.equal(restored.providerAccessState, "verified");
    assert.equal(restored.providerAccessVersion, 5);
    assert.equal(restored.generation, active.generation + 1);
    assert.equal(restored.credentialRef, `github-app:${rotatedIdentity.installationId}`);
    assert.deepEqual(await onboarding.list(tenantId, [identity.installationId]), []);
    assert.deepEqual((await onboarding.list(tenantId, [rotatedIdentity.installationId]))
      .map(({ id }) => id), [active.id]);
    await assert.rejects(onboarding.revalidate({
      ...administrativeInput(tenantId, rotatedIdentity), expectedAccessVersion: currentRevoked.providerAccessVersion,
    }), /version conflict/);
  });

  test("no-row restrictive provider events fence future first enrollment", async () => {
    const tenantId = randomUUID();
    const concurrentIdentity = githubIdentity("example/race", 107);
    assert.equal(await onboarding.invalidate({
      appId: concurrentIdentity.appId,
      installationId: concurrentIdentity.installationId,
      repositoryIds: [concurrentIdentity.repositoryId],
      state: "revoked",
      reason: "repository removed before enrollment completed",
      deliveryId: "delivery-race-107",
    }), 0);
    const enrolled = await onboarding.enroll(administrativeInput(tenantId, concurrentIdentity));
    assert.equal(enrolled.providerAccessState, "unknown");
    assert.equal(await onboarding.invalidate({
      appId: concurrentIdentity.appId,
      installationId: concurrentIdentity.installationId,
      repositoryIds: [concurrentIdentity.repositoryId],
      state: "revoked",
      reason: "duplicate delivery",
      deliveryId: "delivery-race-107",
    }), 0);
    const raceRestriction = await admin.query<{ access_state: string }>(
      `SELECT access_state FROM pr_agent_harness.github_provider_access_restrictions
       WHERE github_app_id=$1 AND installation_id=$2 AND repository_id=$3`,
      [concurrentIdentity.appId, concurrentIdentity.installationId, concurrentIdentity.repositoryId],
    );
    assert.equal(raceRestriction.rows[0]!.access_state, "revoked");
    const raceAudit = await admin.query<{ details_json: Record<string, unknown> }>(
      `SELECT details_json FROM pr_agent_harness.audit_logs
       WHERE tenant_id=$1 AND resource_ref=$2 AND action='github.onboarding.register_restricted'`,
      [tenantId, enrolled.id],
    );
    assert.deepEqual(raceAudit.rows[0]!.details_json, {
      confirmation: "Fresh test enrollment; no previous publisher exists.",
      historicalRestrictionState: "revoked",
      installationId: concurrentIdentity.installationId,
      providerAccessState: "unknown",
      repositoryId: concurrentIdentity.repositoryId,
    });

    const wholeTenantId = randomUUID();
    const first = githubIdentity("example/whole-a", 108);
    assert.equal(await onboarding.invalidate({
      appId: first.appId,
      installationId: first.installationId,
      state: "unknown",
      reason: "installation inventory is unavailable",
      deliveryId: "delivery-whole-108",
    }), 0);
    const firstRestricted = await onboarding.enroll(administrativeInput(wholeTenantId, first));
    const second = { ...first, repository: "example/whole-b", repositoryId: first.repositoryId + 1 };
    const secondRestricted = await onboarding.enroll(administrativeInput(wholeTenantId, second));
    assert.equal(firstRestricted.providerAccessState, "unknown");
    assert.equal(firstRestricted.providerAccessVersion, 1);
    assert.equal(secondRestricted.providerAccessState, "unknown");
    const restored = await onboarding.revalidate({
      ...administrativeInput(wholeTenantId, first),
      expectedAccessVersion: firstRestricted.providerAccessVersion,
    });
    assert.equal(restored.providerAccessState, "verified");
    const third = { ...first, repository: "example/whole-c", repositoryId: first.repositoryId + 2 };
    const thirdRestricted = await onboarding.enroll(administrativeInput(wholeTenantId, third));
    assert.equal(thirdRestricted.providerAccessState, "unknown");
    assert.equal((await onboarding.list(wholeTenantId, []))
      .find(({ id }) => id === secondRestricted.id)?.providerAccessState, "unknown");
    const restrictions = await admin.query<{ count: string }>(
      `SELECT count(*) FROM pr_agent_harness.github_provider_access_restrictions
       WHERE github_app_id=$1 AND installation_id=$2 AND repository_id=0`,
      [first.appId, first.installationId],
    );
    assert.equal(restrictions.rows[0]!.count, "1");
  });

  test("whole-installation invalidation also fences legacy GitHub App bindings", async () => {
    const tenantId = randomUUID();
    const identity = githubIdentity("example/legacy", 106);
    const active = await onboarding.enroll(administrativeInput(tenantId, identity));
    await admin.query(
      "UPDATE pr_agent_harness.integration_bindings SET github_app_id=NULL,github_account_id=NULL WHERE id=$1",
      [active.id],
    );
    assert.equal(await onboarding.invalidate({
      appId: identity.appId, installationId: identity.installationId,
      state: "revoked", reason: "installation suspended", deliveryId: "delivery-installation-106",
    }), 1);
    const revoked = (await onboarding.list(tenantId, []))[0]!;
    assert.equal(revoked.providerAccessState, "revoked");
    const restored = await onboarding.revalidate({
      ...administrativeInput(tenantId, identity),
      expectedAccessVersion: revoked.providerAccessVersion,
    });
    assert.equal(restored.providerAccessState, "verified");
    assert.equal(restored.githubAppId, identity.appId);
    assert.equal(restored.githubAccountId, identity.accountId);
    const audit = await admin.query<{ details_json: Record<string, unknown> }>(
      `SELECT details_json FROM pr_agent_harness.audit_logs
       WHERE tenant_id=$1 AND resource_ref=$2 AND action='github.provider_access.revalidate'
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, active.id],
    );
    assert.equal(audit.rows[0]!.details_json.legacyMetadataRecovered, true);
  });

  test("revalidation abandons never-dispatched prepared operations but refuses uncertain effects", async () => {
    const tenantId = randomUUID();
    const identity = githubIdentity("example/revalidation-operations", 1_110);
    const active = await onboarding.enroll(administrativeInput(tenantId, identity));
    const safe = buildPublicationIdentity({
      scope: {
        tenantId,
        integrationId: active.id,
        platform: "github",
        origin: identity.origin,
        repository: identity.repository,
        target: "pull:prepared",
        revision: "head-prepared",
        authorityGeneration: active.generation,
      },
      slot: "review-prepared",
      payload: { body: "prepared" },
    });
    const database = new RuntimeDatabase(admin);
    await database.transaction(tenantId, (client) => preparePublicationInTransaction(client, safe));
    const batch = await admin.query<{ id: string }>(
      `INSERT INTO pr_agent_harness.publication_batches
         (tenant_id,integration_id,platform,origin,repository,target,revision,
          authority_generation,source_key,source_hash)
       VALUES ($1,$2,'github',$3,$4,'pull:prepared','head-prepared',$5,$6,$7)
       RETURNING id`,
      [tenantId, active.id, identity.origin, identity.repository, active.generation,
        "provider-revalidation-prepared", safe.businessOperationId],
    );
    await admin.query(
      `INSERT INTO pr_agent_harness.publication_batch_operations
         (tenant_id,batch_id,ordinal,business_operation_id)
       VALUES ($1,$2,0,$3)`,
      [tenantId, batch.rows[0]!.id, safe.businessOperationId],
    );
    const restored = await onboarding.revalidate({
      ...administrativeInput(tenantId, identity),
      expectedAccessVersion: active.providerAccessVersion,
    });
    assert.equal(restored.generation, active.generation + 1);
    const abandoned = await admin.query<{
      status: string; outcome_code: string; attempt_count: number; last_error_code: string;
    }>(
      `SELECT status,outcome_code,attempt_count,last_error_code
       FROM pr_agent_harness.repository_operations
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [tenantId, safe.businessOperationId],
    );
    assert.deepEqual(abandoned.rows[0], {
      status: "cancelled",
      outcome_code: "no_effect",
      attempt_count: 0,
      last_error_code: "provider_revalidation_before_dispatch",
    });
    assert.equal((await admin.query<{ count: string }>(
      `SELECT count(*) FROM pr_agent_harness.audit_logs
       WHERE tenant_id=$1 AND resource_ref=$2
         AND action='github.provider_access.prepared_abandoned'`,
      [tenantId, safe.businessOperationId],
    )).rows[0]!.count, "1");

    const uncertain = buildPublicationIdentity({
      scope: {
        tenantId,
        integrationId: active.id,
        platform: "github",
        origin: identity.origin,
        repository: identity.repository,
        target: "pull:unknown",
        revision: "head-unknown",
        authorityGeneration: restored.generation,
      },
      slot: "review-unknown",
      payload: { body: "unknown" },
    });
    await database.transaction(tenantId, (client) => preparePublicationInTransaction(client, uncertain));
    await admin.query(
      `UPDATE pr_agent_harness.repository_operations
       SET status='unknown',attempt_count=1,dispatched_at=now(),next_reconcile_at=now(),version=version+1
       WHERE tenant_id=$1 AND business_operation_id=$2`,
      [tenantId, uncertain.businessOperationId],
    );
    await assert.rejects(onboarding.revalidate({
      ...administrativeInput(tenantId, identity),
      expectedAccessVersion: restored.providerAccessVersion,
    }), /unresolved publication operations prevent provider revalidation/u);
  });

  async function bindingCount(): Promise<number> {
    const result = await admin.query<{ count: string }>("SELECT count(*) FROM pr_agent_harness.integration_bindings");
    return Number(result.rows[0]!.count);
  }

  async function rejectsInTransaction(
    sql: string,
    values: unknown[],
    code: string,
    message: RegExp,
    scopedTenantId?: string,
  ): Promise<void> {
    const client = await onboardingPool.connect();
    try {
      await client.query("BEGIN");
      if (scopedTenantId) {
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [scopedTenantId]);
      }
      await assert.rejects(client.query(sql, values), (error: unknown) => isPgError(error, code, message));
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }
}

function githubIdentity(repository: string, suffix: number): GitHubOnboardingIdentity {
  return {
    origin: "https://api.github.com", repository,
    appId: 2_000 + suffix, installationId: 3_000 + suffix,
    accountId: 4_000 + suffix, repositoryId: 5_000 + suffix, actorId: 6_000 + suffix,
  };
}

function administrativeInput(tenantId: string, identity: GitHubOnboardingIdentity) {
  return {
    tenantId, actor: "test-repository-admin", actorType: "user" as const, identity,
    confirmation: "Fresh test enrollment; no previous publisher exists.",
  };
}

function isPgError(error: unknown, code: string, message: RegExp): boolean {
  return error instanceof Error
    && "code" in error
    && (error as Error & { code: string }).code === code
    && message.test(error.message);
}
