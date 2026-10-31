import { executeEvolutionProposalRun } from "../../evolution/proposals/run.js";
import { executeReplayRun } from "../../evolution/evaluations/run.js";
import { executeFixProposalRun } from "../../fix/proposal/run.js";
import { executeFixPublicationRun } from "../../fix/publication/workflow.js";
import { executeReviewRun } from "../../review/run.js";
import { executeIssueTriageRun } from "../../issues/triage/run.js";
import { executeJudgeRun } from "../../quality/evaluators/run.js";
import type { PublicationBinding } from "../authority/publication-authority.js";
import { RunExecutionContractError, type RunLease } from "../runs/contracts.js";

export type WorkflowExecutor = (lease: RunLease, binding: PublicationBinding) => Promise<void>;
export interface WorkflowRegistration { id: string; execute: WorkflowExecutor }

export const REQUIRED_WORKFLOW_IDS = ["review.single.v1", "review.deep.v1", "issue.triage.v1", "fix.propose.v1",
  "fix.publish.v1", "evolution.propose.v1", "eval.replay.v1", "eval.judge.v1"] as const;

const defaultRegistrations: WorkflowRegistration[] = [
  { id: "review.single.v1", execute: executeReviewRun },
  { id: "review.deep.v1", execute: executeReviewRun },
  { id: "issue.triage.v1", execute: executeIssueTriageRun },
  { id: "fix.propose.v1", execute: executeFixProposalRun },
  { id: "fix.publish.v1", execute: executeFixPublicationRun },
  { id: "evolution.propose.v1", execute: (lease) => executeEvolutionProposalRun(lease) },
  { id: "eval.replay.v1", execute: executeReplayRun },
  { id: "eval.judge.v1", execute: executeJudgeRun },
];

export function createWorkflowRegistry(
  registrations: readonly WorkflowRegistration[] = defaultRegistrations,
  required: readonly string[] = REQUIRED_WORKFLOW_IDS,
): ReadonlyMap<string, WorkflowExecutor> {
  const registry = new Map<string, WorkflowExecutor>();
  for (const registration of registrations) {
    if (!registration.id || typeof registration.execute !== "function") throw new Error("Invalid workflow registration");
    if (registry.has(registration.id)) throw new Error(`Duplicate workflow registration: ${registration.id}`);
    registry.set(registration.id, registration.execute);
  }
  const missing = required.filter((id) => !registry.has(id));
  if (missing.length) throw new Error(`Missing workflow registrations: ${missing.join(", ")}`);
  return registry;
}

export function workflowExecutor(registry: ReadonlyMap<string, WorkflowExecutor>): WorkflowExecutor {
  return async (lease, binding) => {
    const execute = registry.get(String(lease.input.workflow));
    if (!execute) throw new RunExecutionContractError(`Unsupported workflow: ${String(lease.input.workflow)}`);
    await execute(lease, binding);
  };
}
