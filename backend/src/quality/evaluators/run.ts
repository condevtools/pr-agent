import type { PublicationBinding } from "../../agent-runtime/authority/publication-authority.js";
import { currentRunExecutionContext } from "../../agent-runtime/execution/run-context.js";
import type { RunLease } from "../../agent-runtime/runs/contracts.js";
import { assertRuntimeCapability } from "../../agent-runtime/runtime/capabilities.js";
import { RunExecutionContractError } from "../../agent-runtime/runs/contracts.js";
import { canonicalJson, fingerprint } from "../../agent-runtime/versions.js";
import { createStructuredModel } from "../../model/structured-model.js";
import { managedPromptReferences, renderManagedPrompt } from "../prompts/index.js";
import {
  judgeModelJsonSchema,
  judgeModelResultSchema,
  judgePolicySchema,
  judgeResultSchema,
  judgeRunInputSchema,
  judgeSourceSchema,
  type JudgeResult,
} from "./contracts.js";

export async function executeJudgeRun(
  lease: RunLease,
  binding: PublicationBinding,
): Promise<void> {
  const context = currentRunExecutionContext();
  if (!context || context.lease.runId !== lease.runId) {
    throw new RunExecutionContractError("Judge requires its durable Run execution context");
  }
  const input = judgeRunInputSchema.parse(lease.input);
  assertRuntimeCapability("evolution");
  const source = judgeSourceSchema.parse(lease.runtimeConfig.judgeSource);
  const policy = judgePolicySchema.parse(lease.runtimeConfig.judgePolicy);
  assertJudgeScope(lease, binding, input, source,
    policy.rubric, policy.rubricHash);

  const systemPrompt = renderManagedPrompt("evaluation.judge.system", {
    rubric: canonicalJson(policy.rubric),
  });
  const prompt = canonicalJson({
    source: {
      sourceRunId: source.sourceRunId,
      sourceArtifactHash: source.sourceArtifactHash,
      collectionHash: source.collectionHash,
      repository: source.repository,
      baseSha: source.baseSha,
      headSha: source.headSha,
      findings: source.findings,
      collection: source.collection,
    },
  });
  const result = await context.step<JudgeResult>(
    "quality.judge.result.v1",
    "model",
    fingerprint({ sourceHash: source.sourceHash, rubricHash: policy.rubricHash,
      modelVersionHash: lease.modelVersionHash, systemPrompt: systemPrompt.text, prompt }),
    async () => {
      const judged = await createStructuredModel().generate({
        schemaName: "quality_judge_result_v1",
        jsonSchema: judgeModelJsonSchema as unknown as Record<string, unknown>,
        schema: judgeModelResultSchema,
        systemPrompt: systemPrompt.text,
        prompt,
        role: "judge",
        turn: 1,
        maxInputBytes: policy.maxInputBytes,
        maxOutputTokens: policy.maxOutputTokens,
        promptReferences: managedPromptReferences(systemPrompt),
        signal: context.signal,
      });
      assertJudgmentCoverage(source.findings.map(({ id }) => id),
        judged.judgments.map(({ findingId }) => findingId));
      return judgeResultSchema.parse({
        schemaVersion: 1,
        workflow: "eval.judge.v1",
        judgeRunId: lease.runId,
        sourceRunId: source.sourceRunId,
        sourceArtifactHash: source.sourceArtifactHash,
        sourceHash: source.sourceHash,
        promptVersionHash: lease.promptVersionHash,
        modelVersionHash: lease.modelVersionHash,
        rubricHash: policy.rubricHash,
        ...judged,
      });
    },
  );
  judgeResultSchema.parse(result);
}

function assertJudgeScope(
  lease: RunLease,
  binding: PublicationBinding,
  input: ReturnType<typeof judgeRunInputSchema.parse>,
  source: ReturnType<typeof judgeSourceSchema.parse>,
  rubric: unknown,
  rubricHash: string,
): void {
  if (lease.runType !== "eval.judge.v1" || input.workflow !== "eval.judge.v1"
      || lease.tenantId !== binding.tenantId || lease.integrationId !== binding.id
      || lease.authorityGeneration !== binding.generation || binding.state !== "active"
      || !binding.capabilities.evolution || lease.baseSha !== source.baseSha
      || lease.headSha !== source.headSha || input.sourceRunId !== source.sourceRunId
      || input.expectedArtifactHash !== source.sourceArtifactHash
      || input.sourceHash !== source.sourceHash || fingerprint({
        schemaVersion: source.schemaVersion,
        sourceRunId: source.sourceRunId,
        sourceArtifactHash: source.sourceArtifactHash,
        collectionHash: source.collectionHash,
        repository: source.repository,
        baseSha: source.baseSha,
        headSha: source.headSha,
        findings: source.findings,
        collection: source.collection,
      }) !== source.sourceHash || fingerprint(rubric) !== rubricHash) {
    throw new RunExecutionContractError("Judge Run does not match its frozen source, rubric, or binding");
  }
}

function assertJudgmentCoverage(expected: readonly string[], actual: readonly string[]): void {
  const unique = new Set(actual);
  if (unique.size !== actual.length || expected.length !== actual.length
      || expected.some((id) => !unique.has(id))) {
    throw new RunExecutionContractError("Judge must return exactly one judgment per frozen finding");
  }
}
