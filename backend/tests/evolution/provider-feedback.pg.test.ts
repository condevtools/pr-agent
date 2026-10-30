import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { Pool } from "pg";

import { migrateRuntime } from "../../src/agent-runtime/postgres/migrations.js";
import { RuntimeDatabase } from "../../src/agent-runtime/postgres/database.js";
import { fingerprint } from "../../src/agent-runtime/versions.js";
import type { RunPrincipal } from "../../src/agent-runtime/runs/control-contracts.js";
import { PgEvolutionFeedbackStore } from "../../src/evolution/feedback/store.js";
import { parseProviderFeedbackCommand } from "../../src/evolution/feedback/contracts.js";
import { handleGitHubWebhookEvent } from "../../src/integrations/github/webhooks/handler.js";
import { runGitLabWebhook } from "../../src/integrations/gitlab/webhooks/adapter.js";

const databaseUrl = process.env.HARNESS_TEST_DATABASE_URL;
if (!databaseUrl) test.skip("Provider feedback bridge requires Docker PostgreSQL", () => {});
else {
  if (!new URL(databaseUrl).pathname.startsWith("/harness_test_")) throw new Error("Disposable database required");
  const admin = new Pool({ connectionString: databaseUrl });
  const role = `provider_feedback_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();
  const tenantId = randomUUID(); const githubIntegrationId = randomUUID(); const gitlabIntegrationId = randomUUID();
  const disabledGithubIntegrationId = randomUUID();
  const githubRunId = randomUUID(); const gitlabRunId = randomUUID();
  const githubArtifact = artifact(tenantId, githubIntegrationId, githubRunId);
  const gitlabArtifact = artifact(tenantId, gitlabIntegrationId, gitlabRunId);
  let app: Pool; let store: PgEvolutionFeedbackStore;
  let originalFetch: typeof globalThis.fetch;
  const logger = { info: () => undefined, error: () => undefined };

  before(async () => {
    await migrateRuntime(admin);
    await admin.query(`INSERT INTO pr_agent_harness.integration_bindings
      (id,tenant_id,platform,origin,repository,provider_repository_id,provider_actor_id,credential_ref,
       publication_state,publication_generation,quiescence_receipt,review_execution_mode,execution_mode_generation,
       review_deep_enabled,evolution_enabled)
      VALUES ($1,$2,'github','https://api.github.com','acme/widgets','101','201','env:GITHUB_TOKEN',
        'active',1,'{"protocol":"test"}'::jsonb,'harness_async',1,true,true),
       ($3,$2,'gitlab','https://gitlab.example.test','acme/widgets','202','302','env:GITLAB_TOKEN',
        'active',1,'{"protocol":"test"}'::jsonb,'harness_async',1,true,true),
       ($4,$2,'github','https://api.github.com','acme/disabled','103','203','env:GITHUB_TOKEN',
        'active',1,'{"protocol":"test"}'::jsonb,'harness_async',1,true,true)`,
    [githubIntegrationId, tenantId, gitlabIntegrationId, disabledGithubIntegrationId]);
    await insertDeepRun(admin, { tenantId, integrationId: githubIntegrationId, runId: githubRunId,
      platform: "github", origin: "https://api.github.com", providerRepositoryId: 101, number: 7,
      artifact: githubArtifact });
    await insertDeepRun(admin, { tenantId, integrationId: gitlabIntegrationId, runId: gitlabRunId,
      platform: "gitlab", origin: "https://gitlab.example.test", providerRepositoryId: 202, number: 8,
      artifact: gitlabArtifact });
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA pr_agent_harness TO ${role};
      GRANT EXECUTE ON FUNCTION pr_agent_harness.lock_current_binding_capability(uuid,uuid,text) TO ${role};
      GRANT SELECT ON pr_agent_harness.integration_bindings,pr_agent_harness.agent_runs,
        pr_agent_harness.review_artifacts,pr_agent_harness.feedback_observations TO ${role};
      GRANT UPDATE ON pr_agent_harness.agent_runs TO ${role};
      GRANT INSERT ON pr_agent_harness.feedback_observations TO ${role};
      GRANT SELECT,INSERT,UPDATE ON pr_agent_harness.review_feedback_signals TO ${role}`);
    const appUrl = new URL(databaseUrl); appUrl.username = role; appUrl.password = password;
    process.env.HARNESS_DATABASE_URL = appUrl.toString();
    process.env.FEATURE_EVOLUTION = "on";
    process.env.GITHUB_TOKEN = "github-server-token";
    process.env.GITLAB_TOKEN = "gitlab-server-token";
    process.env.GITLAB_BASE_URL = "https://gitlab.example.test";
    app = new Pool({ connectionString: appUrl.toString() });
    store = new PgEvolutionFeedbackStore(new RuntimeDatabase(app));
    originalFetch = globalThis.fetch;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    const { closeAgentRuntime } = await import("../../src/agent-runtime/runtime.js");
    await closeAgentRuntime();
    await app?.end();
    await admin.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    await admin.end();
    delete process.env.FEATURE_EVOLUTION;
  });

  test("provider command parser is explicit and preserves mixed sentiment", () => {
    assert.deepEqual(parseProviderFeedbackCommand(`/feedback ${githubRunId} mixed useful but incomplete`),
      { sourceRunId: githubRunId, sentiment: "mixed", comment: "useful but incomplete" });
    assert.equal(parseProviderFeedbackCommand("ordinary discussion"), undefined);
    assert.equal(parseProviderFeedbackCommand("/feedback latest positive"), undefined);
  });

  test("store rejects every mismatched provider scope and atomically derives a prompt signal", async () => {
    const principal = providerPrincipal(tenantId, githubIntegrationId, "github-user:501");
    const base = providerRequest(githubRunId, "github", "https://api.github.com", 101, 7,
      "github-comment:9001", "501", "mixed");
    const receipt = await store.recordProviderObservation(principal, "provider-feedback:github-comment:9001", base);
    assert.equal(receipt.artifactHash, fingerprint(githubArtifact));
    const duplicate = await store.recordProviderObservation(principal, "provider-feedback:github-comment:9001", base);
    assert.equal(duplicate.id, receipt.id);
    let mismatchOrdinal = 0;
    for (const changed of [
      { ...base, target: { ...base.target, origin: "https://github.example.test" } },
      { ...base, target: { ...base.target, repository: "acme/other" } },
      { ...base, target: { ...base.target, number: 99 } },
      { ...base, sourceRunId: randomUUID() },
    ]) {
      mismatchOrdinal += 1;
      const eventId = `github-comment:mismatch-${mismatchOrdinal}`;
      await assert.rejects(store.recordProviderObservation(principal, `provider-feedback:${eventId}`,
        { ...changed, provenance: { ...changed.provenance, eventId } }), /not found/i);
    }
    await assert.rejects(store.recordProviderObservation(
      providerPrincipal(randomUUID(), githubIntegrationId, "github-user:501"),
      "provider-feedback:github-comment:9001", base), /not found/i);
    const observations = await admin.query<{ observation_json: { sentiment: string; provenance: { eventId: string } } }>(
      "SELECT observation_json FROM pr_agent_harness.feedback_observations WHERE tenant_id=$1 AND source_run_id=$2",
      [tenantId, githubRunId]);
    assert.deepEqual(observations.rows.map((row) => row.observation_json.sentiment), ["mixed"]);
    assert.equal(observations.rows[0]?.observation_json.provenance.eventId, "github-comment:9001");
    assert.equal((await admin.query<{ n: number }>(`SELECT count(*)::integer n FROM pr_agent_harness.review_feedback_signals
      WHERE tenant_id=$1 AND integration_id=$2 AND target='pr:7'`, [tenantId, githubIntegrationId])).rows[0]!.n, 1);
    assert.equal((await admin.query<{ n: number }>("SELECT count(*)::integer n FROM pr_agent_harness.trusted_review_label_sets")).rows[0]!.n, 0);
  });

  test("GitHub accepts authorized feedback once, ignores untrusted actors and disables before permission lookup", async () => {
    let permissionCalls = 0;
    const octokit = { repos: { getCollaboratorPermissionLevel: async () => {
      permissionCalls += 1; return { data: { permission: "write" } };
    } } };
    const payload = githubComment(githubRunId, 9002, 7, 501);
    assert.equal((await handleGitHubWebhookEvent({ eventName:"issue_comment",payload,octokit:octokit as never,
      logger,runtimeMode:"github-app",deliveryId:"delivery-a",sourceHash:fingerprint(payload) })).message,
    "provider feedback recorded");
    await handleGitHubWebhookEvent({ eventName:"issue_comment",payload,octokit:octokit as never,
      logger,runtimeMode:"github-app",deliveryId:"delivery-redelivery",sourceHash:fingerprint(payload) });
    assert.equal((await admin.query<{ n: number }>(`SELECT count(*)::integer n FROM pr_agent_harness.feedback_observations
      WHERE tenant_id=$1 AND source_run_id=$2 AND command_key='provider-feedback:github-comment:9002'`,
    [tenantId,githubRunId])).rows[0]!.n,1);
    const untrusted = githubComment(githubRunId,9003,7,502);
    const readOnly = { repos:{ getCollaboratorPermissionLevel:async()=>({data:{permission:"read"}}) } };
    assert.match((await handleGitHubWebhookEvent({eventName:"issue_comment",payload:untrusted,octokit:readOnly as never,
      logger,runtimeMode:"github-app",deliveryId:"delivery-untrusted",sourceHash:fingerprint(untrusted)})).message,/unauthorized/);
    const wrongRepositoryId = { ...githubComment(githubRunId,9006,7,501),
      repository:{...githubComment(githubRunId,9006,7,501).repository,id:999} };
    const permissionCallsBeforeMismatch = permissionCalls;
    await assert.rejects(handleGitHubWebhookEvent({eventName:"issue_comment",payload:wrongRepositoryId,
      octokit:octokit as never,logger,runtimeMode:"github-app",deliveryId:"delivery-wrong-repo-id",
      sourceHash:fingerprint(wrongRepositoryId)}),/repository identity/i);
    assert.equal(permissionCalls,permissionCallsBeforeMismatch);
    const missingRepositoryId = githubComment(githubRunId,9007,7,501) as ReturnType<typeof githubComment> & {
      repository: { id?: number; name: string; owner: { login: string } } };
    delete missingRepositoryId.repository.id;
    await assert.rejects(handleGitHubWebhookEvent({eventName:"issue_comment",payload:missingRepositoryId,
      octokit:octokit as never,logger,runtimeMode:"github-app",deliveryId:"delivery-missing-repo-id",
      sourceHash:fingerprint(missingRepositoryId)}),/repository identity/i);
    assert.equal(permissionCalls,permissionCallsBeforeMismatch);
    const disabledPolicy = githubComment(githubRunId,9008,7,501);
    disabledPolicy.repository = { id:103,name:"disabled",owner:{login:"acme"} };
    const policyOctokit = { repos:{
      getContent:async()=>({data:{type:"file",encoding:"base64",
        content:Buffer.from("review:\n  feedbackCommandEnabled: false").toString("base64")}}),
      getCollaboratorPermissionLevel:async()=>{ throw new Error("permission lookup must not run"); },
    } };
    assert.match((await handleGitHubWebhookEvent({eventName:"issue_comment",payload:disabledPolicy,
      octokit:policyOctokit as never,logger,runtimeMode:"github-app",deliveryId:"delivery-policy-off",
      sourceHash:fingerprint(disabledPolicy)})).message,/disabled by repository policy/);
    assert.equal((await admin.query<{n:number}>(`SELECT count(*)::integer n FROM pr_agent_harness.feedback_observations
      WHERE tenant_id=$1 AND command_key='provider-feedback:github-comment:9008'`,[tenantId])).rows[0]!.n,0);
    const beforeOff = permissionCalls;
    process.env.FEATURE_EVOLUTION = "off";
    try {
      const off = githubComment(githubRunId,9004,7,501);
      assert.match((await handleGitHubWebhookEvent({eventName:"issue_comment",payload:off,octokit:octokit as never,
        logger,runtimeMode:"github-app",deliveryId:"delivery-off",sourceHash:fingerprint(off)})).message,/evolution disabled/);
      assert.equal(permissionCalls,beforeOff);
    } finally { process.env.FEATURE_EVOLUTION = "on"; }
    const issueComment = { ...githubComment(githubRunId,9005,7,501), issue:{number:7,title:"Issue",body:""} };
    assert.match((await handleGitHubWebhookEvent({eventName:"issue_comment",payload:issueComment,octokit:octokit as never,
      logger,runtimeMode:"github-app",deliveryId:"delivery-issue",sourceHash:fingerprint(issueComment)})).message,
      /outside pull request/);
    assert.equal(permissionCalls,beforeOff);
  });

  test("GitLab uses server credentials and Developer authorization for provider feedback", async () => {
    const seenAuthorization: Array<{url:string;token:string}> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seenAuthorization.push({url:String(input),token:new Headers(init?.headers).get("PRIVATE-TOKEN") ?? ""});
      if (String(input).includes("/repository/files/")) return new Response("", { status:404 });
      return new Response(JSON.stringify({ access_level: 30 }), { status: 200,
        headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const payload = gitlabNote(gitlabRunId,7001,8,601);
    assert.equal((await runGitLabWebhook({payload,headers:{},logger,skipSecurityVerification:true})).message,
      "provider feedback recorded");
    assert.equal(seenAuthorization.find((entry)=>entry.url.includes("/members/all/"))?.token,"gitlab-server-token");
    globalThis.fetch = (async () => new Response(JSON.stringify({ access_level: 20 }), { status: 200,
      headers:{"content-type":"application/json"} })) as typeof fetch;
    const denied = gitlabNote(gitlabRunId,7002,8,602);
    assert.match((await runGitLabWebhook({payload:denied,headers:{},logger,skipSecurityVerification:true})).message,
      /unauthorized/);
    const disabledByPolicy = gitlabNote(gitlabRunId,7006,8,606);
    disabledByPolicy.merge_request!.target_branch = "disabled";
    const disabledUrls:string[]=[];
    globalThis.fetch = (async (input:string|URL|Request) => {
      disabledUrls.push(String(input));
      if (String(input).includes("/repository/files/")) return new Response(
        "review:\n  feedbackCommandEnabled: false",{status:200});
      throw new Error("permission lookup must not run");
    }) as typeof fetch;
    assert.match((await runGitLabWebhook({payload:disabledByPolicy,headers:{},logger,skipSecurityVerification:true})).message,
      /disabled by repository policy/);
    assert.equal(disabledUrls.some((url)=>url.includes("/members/all/")),false);
    assert.equal((await admin.query<{n:number}>(`SELECT count(*)::integer n FROM pr_agent_harness.feedback_observations
      WHERE tenant_id=$1 AND command_key='provider-feedback:gitlab-note:7006'`,[tenantId])).rows[0]!.n,0);
    const notMergeRequest = { ...gitlabNote(gitlabRunId,7003,8,603),
      object_attributes:{ ...gitlabNote(gitlabRunId,7003,8,603).object_attributes, noteable_type:"Issue" } };
    globalThis.fetch = (async () => { throw new Error("permission lookup must not run"); }) as typeof fetch;
    assert.match((await runGitLabWebhook({payload:notMergeRequest,headers:{},logger,skipSecurityVerification:true})).message,
      /not a created merge request note/);
    const wrongProjectId = { ...gitlabNote(gitlabRunId,7004,8,604),
      project:{...gitlabNote(gitlabRunId,7004,8,604).project,id:999} };
    await assert.rejects(runGitLabWebhook({payload:wrongProjectId,headers:{},logger,skipSecurityVerification:true}),
      /project identity/i);
    const wrongPath = { ...gitlabNote(gitlabRunId,7005,8,605),
      project:{...gitlabNote(gitlabRunId,7005,8,605).project,path_with_namespace:"other/widgets"} };
    assert.match((await runGitLabWebhook({payload:wrongPath,headers:{},logger,skipSecurityVerification:true})).message,
      /unmanaged repository/);
    assert.equal((await admin.query<{ n:number }>(`SELECT count(*)::integer n FROM pr_agent_harness.feedback_observations
      WHERE tenant_id=$1 AND source_run_id=$2`,[tenantId,gitlabRunId])).rows[0]!.n,1);
  });

  test("uncorrelated GitHub review-thread feedback is explicitly ignored", async () => {
    const result = await handleGitHubWebhookEvent({eventName:"pull_request_review_thread",payload:{action:"resolved",
      repository:{name:"widgets",owner:{login:"acme"}},pull_request:{number:7}},octokit:{} as never,logger,
      runtimeMode:"github-app",deliveryId:"thread-1",sourceHash:fingerprint("thread-1")});
    assert.match(result.message,/no authoritative Deep Review artifact correlation/);
  });
}

function providerPrincipal(tenantId:string,integrationId:string,subjectId:string):RunPrincipal {
  return {tenantId,integrationId,subjectId,actorType:"user",permissions:[]};
}
function artifact(tenantId:string,integrationId:string,runId:string) {
  return {workflowId:"review.deep.v1",identity:{tenantId,integrationId,runId},sourceCoverage:{status:"complete"}};
}
function providerRequest(sourceRunId:string,platform:"github"|"gitlab",origin:string,providerRepositoryId:number,
  number:number,eventId:string,actorProviderId:string,sentiment:"positive"|"negative"|"mixed") {
  return {sourceRunId,sentiment,comment:"provider observation",target:{platform,origin,repository:"acme/widgets",
    providerRepositoryId,number},provenance:{method:"authorized_provider_comment" as const,provider:platform,eventId,
    actorProviderId,providerSentiment:sentiment}};
}
async function insertDeepRun(pool:Pool,input:{tenantId:string;integrationId:string;runId:string;platform:"github"|"gitlab";
  origin:string;providerRepositoryId:number;number:number;artifact:ReturnType<typeof artifact>}) {
  const version=fingerprint(`version:${input.runId}`); const head="2".repeat(40);
  const runInput={schemaVersion:1,workflow:"review.deep.v1",platform:input.platform,target:{origin:input.origin,
    repository:"acme/widgets",number:input.number,providerRepositoryId:input.providerRepositoryId},
  source:{key:`source:${input.runId}`,hash:fingerprint(`source:${input.runId}`)},revision:{baseSha:"1".repeat(40),headSha:head},
  mode:"comment",trigger:"comment-command",options:{customRules:[],includeCiChecks:true,enableSecretScan:true,
    secretScanCustomPatterns:[],enableAutoLabel:false},presentation:{title:"PR",body:"",author:"actor",baseBranch:"main",
    headBranch:"feature",webUrl:"https://example.test/pr",draft:false}};
  await pool.query(`INSERT INTO pr_agent_harness.agent_runs
    (id,tenant_id,integration_id,created_by_actor_type,created_by_actor_id,create_scope,create_key,request_hash,run_type,
     base_sha,head_sha,workflow_version_hash,prompt_version_hash,model_version_hash,tool_version_hash,policy_version_hash,
     runtime_version_hash,input_json,status,authority_generation,execution_mode_generation,deadline_at,finished_at)
    VALUES ($1,$2,$3,'service','provider-feedback-test','provider-feedback',$8,$4,'review.deep.v1',$5,$6,$4,$4,$4,$4,$4,$4,
      $7::jsonb,'succeeded',1,1,clock_timestamp()+interval '1 hour',clock_timestamp())`,
  [input.runId,input.tenantId,input.integrationId,version,"1".repeat(40),head,JSON.stringify(runInput),input.runId]);
  await pool.query(`INSERT INTO pr_agent_harness.review_artifacts
    (id,tenant_id,integration_id,run_id,workflow_id,publication_mode,head_sha,content_hash,artifact_json)
    VALUES ($1,$2,$3,$4,'review.deep.v1','shadow',$5,$6,$7::jsonb)`,
  [fingerprint(`artifact-id:${input.runId}`),input.tenantId,input.integrationId,input.runId,head,
    fingerprint(input.artifact),JSON.stringify(input.artifact)]);
}
function githubComment(runId:string,commentId:number,pullNumber:number,userId:number) {
  return {action:"created",repository:{id:101,name:"widgets",owner:{login:"acme"}},issue:{number:pullNumber,title:"PR",body:"",
    pull_request:{}},comment:{id:commentId,body:`/feedback ${runId} positive useful review`,
    user:{id:userId,type:"User",login:`user-${userId}`}}};
}
function gitlabNote(runId:string,noteId:number,mr:number,userId:number) {
  return {object_kind:"note",user:{id:userId,username:`user-${userId}`},project:{id:202,name:"widgets",
    web_url:"https://gitlab.example.test/acme/widgets",path_with_namespace:"acme/widgets"},object_attributes:{id:noteId,
    action:"create",noteable_type:"MergeRequest",noteable_iid:mr,note:`/feedback ${runId} negative missed issue`},
  merge_request:{iid:mr,title:"MR",description:"",source_branch:"feature",target_branch:"main",
    url:`https://gitlab.example.test/acme/widgets/-/merge_requests/${mr}`,state:"opened"}};
}
