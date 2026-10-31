import { logCore } from "#core";
import type { PublicationBinding } from "../../agent-runtime/authority/publication-authority.js";
import { currentRunExecutionContext } from "../../agent-runtime/execution/run-context.js";
import { StalePublicationError } from "../../agent-runtime/publication/publication.js";
import { publicationRuntimeForBinding } from "../../agent-runtime/runtime/publication.js";
import { RunExecutionContractError, type RunLease } from "../../agent-runtime/runs/contracts.js";
import { fingerprint } from "../../agent-runtime/versions.js";
import { createRestBackedOctokit } from "../../integrations/github/api/http-client.js";
import { githubIssueRevision, parseGitHubIssueSubject } from "../../integrations/github/issues/identity.js";
import { assertGitHubBindingAccess } from "../../integrations/github/onboarding/provider.js";
import { publishGitHubIssueCommentDurably, publishGitHubLabelsDurably } from "../../integrations/github/publication/adapter.js";
import { prepareGitHubPublicationBatch } from "../../review/platforms/github/publication.js";
import { incrementMetricCounter } from "../../http/system/metrics-runtime.js";
import { analyzeIssueTriage } from "./analysis.js";
import { collectIssueTriageContext } from "./collection.js";
import { inferIssueTriageLabels, selectExistingIssueLabels } from "./labels.js";
import { renderIssueTriageComment } from "./presentation.js";
import { issueTriageIdentity, issueTriageRunInputSchema } from "./input.js";
import { loadIssueTriagePolicy } from "./policy.js";

export async function executeIssueTriageRun(lease: RunLease, binding: PublicationBinding): Promise<void> {
  const input = issueTriageRunInputSchema.parse(lease.input);
  const execution = currentRunExecutionContext();
  if (!execution || execution.lease.runId !== lease.runId || binding.platform !== "github"
      || binding.id !== lease.integrationId || binding.tenantId !== lease.tenantId
      || binding.generation !== lease.authorityGeneration || input.target.repository !== binding.repository
      || input.target.origin !== binding.origin || input.target.providerRepositoryId !== binding.providerRepositoryId
      || input.target.issueId !== input.issue.id || input.target.number !== input.issue.number
      || input.revision !== lease.headSha || input.revision !== lease.baseSha
      || input.revision !== githubIssueRevision(input.issue)) {
    throw new RunExecutionContractError("Issue triage Run identity does not match its execution authority");
  }
  const runtime = await publicationRuntimeForBinding(binding);
  await assertGitHubBindingAccess(binding);
  const [owner, repo, extra] = binding.repository.split("/");
  if (!owner || !repo || extra) throw new RunExecutionContractError("Invalid GitHub repository identity");
  const octokit = createRestBackedOctokit({ token: await runtime.resolveCredential(), baseUrl: binding.origin });
  const context = { repo: () => ({ owner, repo }), octokit,
    log: { info: () => undefined, error: () => logCore("error", "issue_triage.provider_failed", { runId: lease.runId }) } };
  const identity = issueTriageIdentity(binding.id, input);
  const batch = await prepareGitHubPublicationBatch({ runtime: { ...runtime, binding: { ...binding, platform: "github" } },
    pullNumber: input.target.number, revision: input.revision, sourceKey: `issue-triage:${identity.key}`, sourceHash: identity.hash });
  if (batch.resumed) {
    count("resumed");
    return;
  }
  const assertCurrent = async () => {
    await execution.assertActive();
    const current = parseGitHubIssueSubject((await octokit.issues.get!({ owner, repo, issue_number: input.target.number })).data);
    if (current.id !== input.target.issueId || current.number !== input.target.number
        || current.state !== "open" || githubIssueRevision(current) !== input.revision) {
      count("stale");
      throw new StalePublicationError(lease.runId);
    }
  };
  await assertCurrent();
  const policy = await loadIssueTriagePolicy(context);
  if (!policy.enabled) throw new RunExecutionContractError("Issue triage disabled by repository policy");
  const collected = await execution.step("issue.triage.collect", "tool",
    fingerprint({ revision: input.revision, tool: lease.toolVersionHash }), () => collectIssueTriageContext({
      octokit, owner, repo, issueNumber: input.target.number, title: input.issue.title, body: input.issue.body ?? "",
    }));
  const assessment = await execution.step("issue.triage.analyze", "model",
    fingerprint({ input, similar: collected.similar, prompt: lease.promptVersionHash, model: lease.modelVersionHash }), async () => {
      try { return await analyzeIssueTriage({ issue: { id: input.issue.id, number: input.issue.number,
        title: input.issue.title, body: input.issue.body ?? "", state: "open", author: input.issue.user.login },
      repository: binding.repository, similar: collected.similar, locale: input.options.locale, signal: execution.signal }); }
      catch (error) { count("model_failed"); throw error; }
    });
  const suggestedLabels = inferIssueTriageLabels({ title: input.issue.title, body: input.issue.body ?? "", similar: collected.similar });
  const autoLabels = input.options.autoLabels && policy.autoLabels
    ? selectExistingIssueLabels(suggestedLabels, collected.repositoryLabels, collected.labelsComplete) : [];
  const result = await execution.step("issue.triage.result", "coordination",
    fingerprint({ assessment, collected, suggestedLabels, autoLabels, revision: input.revision }), async () => ({
      schemaVersion: 1, workflow: input.workflow, revision: input.revision, assessment,
      similar: collected.similar, suggestedLabels, autoLabels, coverage: collected.coverage,
      comment: renderIssueTriageComment({ result: assessment, similar: collected.similar, suggestedLabels, autoLabels,
        labelsComplete: collected.labelsComplete, revision: input.revision, repository: binding.repository, locale: input.options.locale }),
    }));
  await assertCurrent();
  // Additive labels first: the comment's label outcome must never precede that operation.
  if (result.autoLabels.length) await publishGitHubLabelsDurably({ runtime: batch.runtime, context, owner, repo,
    pullNumber: input.target.number, targetKind: "issue", revision: input.revision, slot: "issue-triage:labels", labels: result.autoLabels });
  await publishGitHubIssueCommentDurably({ runtime: batch.runtime, context, owner, repo, pullNumber: input.target.number,
    targetKind: "issue", revision: input.revision, slot: "issue-triage:comment", body: result.comment,
    managedMarkerKey: `issue-ai-triage:${input.revision}` });
  await batch.finish();
  count("published");
}

function count(outcome: "stale" | "model_failed" | "published" | "resumed") {
  incrementMetricCounter("pr_agent_issue_triage_execution_total", { outcome });
}
