import { z } from "zod";

import { canonicalJson, fingerprint } from "../agent-runtime/versions.js";
import type {
  FixArtifact,
  FixProposal,
  FixSource,
  FixWorkflowContext,
  FixWorkflowPolicy,
} from "./contracts.js";
import { FixPatchValidationError, validateFixPatchPair } from "./patch-validator.js";

const draftSchema = z.object({
  codePatch: z.string().min(1).max(128_000),
  testPatch: z.string().min(1).max(128_000),
  summary: z.string().min(1).max(2_000),
}).strict();

export const fixDraftJsonSchema: Record<string, unknown> = {
  type: "object", additionalProperties: false, required: ["codePatch", "testPatch", "summary"],
  properties: {
    codePatch: { type: "string", minLength: 1, maxLength: 128_000 },
    testPatch: { type: "string", minLength: 1, maxLength: 128_000 },
    summary: { type: "string", minLength: 1, maxLength: 2_000 },
  },
};

export async function executeFixProposal(
  source: FixSource,
  context: FixWorkflowContext,
  policy: FixWorkflowPolicy,
): Promise<FixArtifact> {
  assertIdentity(source, context);
  const recovered = await context.store.loadArtifact(context.lease);
  if (recovered) return recovered;
  await context.store.registerSource(context.lease, source);
  const sourceFiles = await context.step("fix.source_files", "tool",
    fingerprint({ sourceBundleHash: source.sourceBundleHash, allowedPaths: source.allowedPaths }),
    () => context.readSourceFiles(source.allowedPaths));
  assertSourceFiles(source, sourceFiles, policy.maxInputBytes);
  let previousFailure: string | undefined;
  let proposal: FixProposal | undefined;
  for (let revision = 1; revision <= policy.maxProposalRevisions; revision += 1) {
    const draft = await context.step(`fix.proposal.${revision}.model`, "model",
      fingerprint({ source: promptSource(source), sourceFiles, policyHash: policy.verification.hash, revision, previousFailure }),
      () => context.model.generate({
        schemaName: "fix_patch_draft", jsonSchema: fixDraftJsonSchema, schema: draftSchema,
        systemPrompt: "Produce a minimal unified diff fix and an independent regression test. Do not modify dependencies, scripts, configuration, generated files, existing tests, or files outside the supplied allow-list. Return JSON only.",
        prompt: canonicalJson({ source: promptSource(source), sourceFiles, allowedPaths: source.allowedPaths,
          allowedTestPrefixes: policy.verification.allowedTestPrefixes, revision, previousFailure }),
        role: "fix", turn: revision, maxInputBytes: policy.maxInputBytes,
        maxOutputTokens: policy.maxOutputTokensPerRevision, signal: context.signal,
      }));
    try {
      proposal = await context.step(`fix.proposal.${revision}.validate`, "verification",
        fingerprint({ draft, sourceBundleHash: source.sourceBundleHash, policyHash: policy.verification.hash }),
        async () => buildProposal(source, sourceFiles, draft, revision as 1 | 2, policy));
      await context.store.registerProposal(context.lease, `fix.proposal.${revision}.validate`, proposal);
      break;
    } catch (error) {
      if (!(error instanceof FixPatchValidationError)) throw error;
      previousFailure = error.code;
    }
  }
  if (!proposal) {
    const artifact = failedArtifact(source, [previousFailure ?? "proposal_invalid"]);
    await context.store.saveArtifact(context.lease, artifact);
    return artifact;
  }
  let verification = await context.store.loadVerification(context.lease, proposal.id);
  if (!verification) {
    const stepKey = `fix.verify.${proposal.revision}`;
    verification = await context.step(stepKey, "verification",
      fingerprint({ proposalHash: proposal.proposalHash, policyHash: proposal.policyHash,
        sourceBundleHash: proposal.sourceBundleHash }),
      () => context.waitForVerification(proposal!));
    await context.store.registerVerification(context.lease, stepKey, proposal, verification);
  }
  if (verification.proposalHash !== proposal.proposalHash || verification.policyHash !== proposal.policyHash
      || verification.imageDigest !== policy.verification.nodeImageDigest) {
    throw new Error("fix verification does not match the immutable proposal policy");
  }
  const relevanceAttested = verification.relevance === "verified"
    && verification.relevanceAttestation?.testPatchHash === proposal.testPatchHash;
  const qualified = proposal.qualificationStatus === "verified" && policy.verification.publishEnabled && relevanceAttested;
  const outcome = verification.outcome === "verified" && qualified ? "verified"
    : verification.outcome === "failed" ? "failed" : "suggestion_only";
  const reasonCodes = [...verification.reasonCodes];
  if (!qualified) reasonCodes.push("publishing_not_qualified");
  if (!relevanceAttested) reasonCodes.push("relevance_attestation_missing");
  const artifact: FixArtifact = { workflowId: "fix.propose.v1", publicationMode: "suggestion_only",
    source, proposal, verification, outcome, reasonCodes: [...new Set(reasonCodes)] };
  await context.store.saveArtifact(context.lease, artifact);
  return artifact;
}

function assertSourceFiles(
  source: FixSource,
  files: readonly { path: string; content: string }[],
  maxBytes: number,
): void {
  const expected = new Set(source.allowedPaths);
  if (files.length !== expected.size || files.some((file) => !expected.delete(file.path)) || expected.size > 0
      || files.some((file) => typeof file.content !== "string")
      || Buffer.byteLength(JSON.stringify(files)) > maxBytes) {
    throw new Error("trusted fix source snapshot did not return the exact bounded allow-list");
  }
}

function buildProposal(
  source: FixSource,
  sourceFiles: readonly { path: string; content: string }[],
  draft: z.infer<typeof draftSchema>,
  revision: 1 | 2,
  policy: FixWorkflowPolicy,
): FixProposal {
  const validated = validateFixPatchPair(draft.codePatch, draft.testPatch, source, policy, sourceFiles);
  const trustedCommandHash = fingerprint(policy.verification.argv);
  const qualification = policy.verification.qualification;
  const qualificationStatus: FixProposal["qualificationStatus"] = policy.verification.publishEnabled && qualification
      && qualification.policyHash === policy.verification.hash
      && qualification.trustedCommandHash === trustedCommandHash
      && qualification.imageDigest === policy.verification.nodeImageDigest
      && qualification.caseCount >= 50 && qualification.repositoryCount >= 10
    ? "verified" : "not_verified";
  const identity = {
    tenantId: source.tenantId, integrationId: source.integrationId, runId: source.runId,
    sourceReviewRunId: source.sourceReviewRunId, findingId: source.findingId, revision,
    repository: source.repository, baseSha: source.baseSha, headSha: source.headSha,
    sourceBundleRef: source.sourceBundleRef, sourceBundleHash: source.sourceBundleHash,
    codePatch: validated.code.patch, testPatch: validated.test.patch,
    codePatchHash: validated.code.hash, testPatchHash: validated.test.hash,
    policyId: policy.verification.id, policyHash: policy.verification.hash, trustedCommandHash,
    dependencyLockPath: policy.verification.dependencyLockPath,
    dependencyLockHash: policy.verification.dependencyLockHash,
    sandboxPolicyHash: policy.verification.sandboxHash,
    imageDigest: policy.verification.nodeImageDigest,
    publisherPolicyHash: policy.verification.publisherPolicyHash, qualificationStatus,
    ...(qualificationStatus === "verified" && qualification
      ? { qualificationReceiptId: qualification.receiptId, qualificationEvidenceHash: qualification.evidenceHash }
      : {}),
  };
  const proposalHash = fingerprint(identity);
  return { id: fingerprint({ runId: source.runId, revision, proposalHash }), ...identity, proposalHash };
}

function promptSource(source: FixSource): Record<string, unknown> {
  return { platform: source.platform, repository: source.repository, baseSha: source.baseSha,
    headSha: source.headSha, findingId: source.findingId, finding: source.finding };
}

function failedArtifact(source: FixSource, reasonCodes: readonly string[]): FixArtifact {
  return { workflowId: "fix.propose.v1", publicationMode: "suggestion_only", source,
    outcome: "failed", reasonCodes };
}

function assertIdentity(source: FixSource, context: FixWorkflowContext): void {
  const lease = context.lease;
  if (source.tenantId !== lease.tenantId || source.integrationId !== lease.integrationId
      || source.runId !== lease.runId || source.baseSha !== lease.baseSha || source.headSha !== lease.headSha) {
    throw new Error("fix source does not match the fixed Run lease");
  }
}
