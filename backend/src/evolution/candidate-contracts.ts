import { z } from "zod";
import type { ReviewStrategyText } from "../review/strategy/contracts.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const evolutionProposalRequestSchema = z.object({ datasetId: z.string().uuid() }).strict();

export interface EvolutionDevelopmentCaseSummary {
  caseId: string;
  sourceRunId: string;
  repository: string;
  sourceArtifactHash: string;
  labelSetHash: string;
  expectedFindings: readonly {
    path: string;
    startLine: number;
    endLine: number;
    severity: "low" | "medium" | "high";
    title: string;
  }[];
}

export interface EvolutionProposalSource {
  schemaVersion: 1;
  datasetId: string;
  datasetVersion: number;
  datasetManifestHash: string;
  baselinePromptText: string;
  baselineToolDescriptionText: string;
  baselinePromptHash: string;
  baselineToolHash: string;
  developmentCases: readonly EvolutionDevelopmentCaseSummary[];
  sourceHash: string;
}

export const evolutionProposalSourceSchema: z.ZodType<EvolutionProposalSource> = z.object({
  schemaVersion: z.literal(1), datasetId: z.string().uuid(), datasetVersion: z.number().int().positive(),
  datasetManifestHash: sha256, baselinePromptText: z.string().min(1).max(32_768),
  baselineToolDescriptionText: z.string().min(1).max(32_768), baselinePromptHash: sha256, baselineToolHash: sha256,
  developmentCases: z.array(z.object({ caseId: z.string().uuid(), sourceRunId: z.string().uuid(),
    repository: z.string().min(1).max(512), sourceArtifactHash: sha256, labelSetHash: sha256,
    expectedFindings: z.array(z.object({ path: z.string().min(1).max(512), startLine: z.number().int().positive(),
      endLine: z.number().int().positive(), severity: z.enum(["low", "medium", "high"]),
      title: z.string().min(1).max(300) }).strict()).max(100) }).strict()).min(1).max(500),
  sourceHash: sha256,
}).strict();

export interface EvolutionProposalRunInput {
  schemaVersion: 1;
  workflow: "evolution.propose.v1";
  datasetId: string;
  datasetVersion: number;
  datasetManifestHash: string;
  sourceHash: string;
}

export interface EvolutionCandidateRecord {
  id: string;
  tenantId: string;
  proposalRunId: string;
  datasetId: string;
  datasetVersion: number;
  datasetManifestHash: string;
  status: "research_draft";
  candidate: ReviewStrategyText;
  candidateHash: string;
  baselinePromptHash: string;
  baselineToolHash: string;
  modelConfigHash: string;
  createdBy: { type: "user" | "service"; id: string };
  createdAt: string;
}

export const evolutionProposalRunInputSchema: z.ZodType<EvolutionProposalRunInput> = z.object({
  schemaVersion: z.literal(1), workflow: z.literal("evolution.propose.v1"), datasetId: z.string().uuid(),
  datasetVersion: z.number().int().positive(), datasetManifestHash: sha256, sourceHash: sha256,
}).strict();
