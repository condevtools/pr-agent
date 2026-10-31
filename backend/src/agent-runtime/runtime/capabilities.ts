import type { PublicationBinding } from "../authority/publication-authority.js";

export type ReviewWorkflow = "review.single.v1" | "review.deep.v1";
export type ProductCapability = "review.single" | "review.deep" | "issue.triage" | "fix" | "evolution";

export interface RuntimeCapabilityConfiguration {
  reviewSingle: true;
  reviewDeep: boolean;
  /** Optional only for rolling-upgrade compatibility with pre-033 heartbeat fixtures. */
  issueTriage?: boolean;
  fix: boolean;
  evolution: boolean;
}

export interface BindingCapabilities {
  reviewSingle: true;
  reviewDeep: boolean;
  /** Missing only on bindings read from a pre-033 schema during a rolling upgrade. */
  issueTriage?: boolean;
  fix: boolean;
  evolution: boolean;
  defaultReviewWorkflow: ReviewWorkflow;
}

export function resolveRuntimeCapabilities(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeCapabilityConfiguration {
  const capabilities = {
    reviewSingle: true as const,
    reviewDeep: strictFeatureFlag(env, "FEATURE_DEEP_REVIEW", true),
    issueTriage: strictFeatureFlag(env, "FEATURE_ISSUE_TRIAGE", true),
    fix: strictFeatureFlag(env, "FEATURE_FIX", false),
    evolution: strictFeatureFlag(env, "FEATURE_EVOLUTION", false),
  };
  if (capabilities.fix && !env.FIX_DEFAULT_POLICY_ID?.trim()) {
    throw new Error("FEATURE_FIX=on requires FIX_DEFAULT_POLICY_ID");
  }
  return capabilities;
}

export function bindingAllowsCapability(
  binding: Pick<PublicationBinding, "capabilities">,
  capability: ProductCapability,
  runtime: RuntimeCapabilityConfiguration = resolveRuntimeCapabilities(),
): boolean {
  if (capability === "review.single") return true;
  if (capability === "review.deep") return runtime.reviewDeep && binding.capabilities.reviewDeep;
  if (capability === "issue.triage") {
    return runtime.issueTriage !== false && binding.capabilities.issueTriage !== false;
  }
  if (capability === "fix") return runtime.fix && binding.capabilities.fix;
  return runtime.evolution && binding.capabilities.evolution;
}

export function runtimeAllowsCapability(
  capability: ProductCapability,
  runtime: RuntimeCapabilityConfiguration = resolveRuntimeCapabilities(),
): boolean {
  if (capability === "review.single") return true;
  if (capability === "review.deep") return runtime.reviewDeep;
  if (capability === "issue.triage") return runtime.issueTriage !== false;
  if (capability === "fix") return runtime.fix;
  return runtime.evolution;
}

export function assertRuntimeCapability(
  capability: ProductCapability,
  runtime?: RuntimeCapabilityConfiguration,
): void {
  if (!runtimeAllowsCapability(capability, runtime)) {
    throw new Error(`Capability is disabled by runtime configuration: ${capability}`);
  }
}

export function assertBindingCapability(
  binding: Pick<PublicationBinding, "capabilities">,
  capability: ProductCapability,
  runtime?: RuntimeCapabilityConfiguration,
): void {
  if (!bindingAllowsCapability(binding, capability, runtime)) {
    throw new Error(`Capability is not enabled for this integration: ${capability}`);
  }
}

export function workflowCapability(workflow: string): ProductCapability | undefined {
  if (workflow === "review.single.v1") return "review.single";
  if (workflow === "review.deep.v1") return "review.deep";
  if (workflow === "issue.triage.v1") return "issue.triage";
  if (workflow === "fix.propose.v1" || workflow === "fix.publish.v1") return "fix";
  if (workflow === "evolution.propose.v1" || workflow === "eval.replay.v1" || workflow === "eval.judge.v1") return "evolution";
  return undefined;
}

export function supportedWorkflowIds(capabilities: RuntimeCapabilityConfiguration): string[] {
  return [
    "review.single.v1",
    ...(capabilities.issueTriage !== false ? ["issue.triage.v1"] : []),
    ...(capabilities.reviewDeep ? ["review.deep.v1"] : []),
    ...(capabilities.fix ? ["fix.propose.v1", "fix.publish.v1"] : []),
    ...(capabilities.evolution ? ["evolution.propose.v1", "eval.replay.v1", "eval.judge.v1"] : []),
  ];
}

export function supportedWorkflowIdsForBinding(
  capabilities: RuntimeCapabilityConfiguration,
  binding: Pick<PublicationBinding, "capabilities" | "platform">,
): string[] {
  return [
    "review.single.v1",
    ...(binding.platform === "github" && bindingAllowsCapability(binding, "issue.triage", capabilities)
      ? ["issue.triage.v1"] : []),
    ...(bindingAllowsCapability(binding, "review.deep", capabilities) ? ["review.deep.v1"] : []),
    ...(bindingAllowsCapability(binding, "fix", capabilities) ? ["fix.propose.v1", "fix.publish.v1"] : []),
    ...(bindingAllowsCapability(binding, "evolution", capabilities)
      ? ["evolution.propose.v1", "eval.replay.v1", "eval.judge.v1"] : []),
  ];
}

function strictFeatureFlag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "on") return true;
  if (raw === "off") return false;
  throw new Error(`${name} must be exactly on or off`);
}
