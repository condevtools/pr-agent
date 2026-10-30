import { fingerprint } from "../../agent-runtime/versions.js";
import type { EvolutionReleasePolicyV1 } from "./contracts.js";

export function evolutionReleasePolicy(environment: NodeJS.ProcessEnv = process.env): EvolutionReleasePolicyV1 {
  const configured = environment.EVOLUTION_RELEASE_ACTIVATION_ENABLED?.trim();
  if (configured !== undefined && configured !== "true" && configured !== "false") {
    throw new Error("EVOLUTION_RELEASE_ACTIVATION_ENABLED must be true or false");
  }
  return Object.freeze({ schemaVersion: 1, activationEnabled: configured === "true",
    minimumCases: 300, minimumRepositories: 30, minimumSeverityCases: 30, minimumLanguageCases: 30,
    requiredLanguages: ["typescript", "javascript"] as const, requiredRepetitions: 3, minimumQualityRatio: 1.03,
    maximumCostRatio: 1.2, maximumCanaryBps: 500, minimumCanaryMs: 86_400_000,
    minimumCandidateSelections: 100, minimumControlSelections: 100 });
}

export function evolutionReleasePolicyHash(policy: EvolutionReleasePolicyV1): string { return fingerprint(policy); }
