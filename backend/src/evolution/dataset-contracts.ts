import { z } from "zod";

import type { RunPrincipal } from "../harness/run-control-contracts.js";

const safePath = z.string().min(1).max(512).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") && !value.includes("\0")
  && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "unsafe repository path");
const isoTime = z.string().datetime({ offset: true });

export const createDatasetSchema = z.object({
  name: z.string().trim().min(1).max(120),
  developmentBefore: isoTime, validationBefore: isoTime,
}).strict().refine((value) => new Date(value.developmentBefore) < new Date(value.validationBefore),
  "developmentBefore must precede validationBefore");

export const addDatasetCaseSchema = z.object({
  expectedVersion: z.number().int().positive(), sourceRunId: z.string().uuid(), labelSetId: z.string().uuid(),
}).strict();
export const freezeDatasetSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();

export interface DatasetSplitPolicyV1 {
  schemaVersion: 1;
  strategy: "repository_time_v1";
  developmentBefore: string;
  validationBefore: string;
  nearDuplicateThreshold: 0.85;
}

export interface DatasetFixtureFile {
  path: string;
  kind: "source" | "manifest";
  content: string;
  contentHash: string;
  sizeBytes: number;
}

export interface DatasetFixtureV1 {
  schemaVersion: 1;
  sourceRunId: string;
  platform: "github" | "gitlab";
  repository: string;
  pullNumber: number;
  baseSha: string;
  headSha: string;
  sourceCreatedAt: string;
  input: Record<string, unknown>;
  collected: Record<string, unknown>;
  coverage: { status: "complete"; reasonCodes: [];
    repositoryRead: { status: "complete" | "partial"; reasonCodes: string[]; availablePaths: string[] } };
  ci: unknown;
  files: DatasetFixtureFile[];
  fixtureHash: string;
  totalBytes: number;
}

export interface DatasetCaseSource {
  tenantId: string;
  integrationId: string;
  sourceRunId: string;
  platform: "github" | "gitlab";
  origin: string;
  repository: string;
  providerRepositoryId: number;
  pullNumber: number;
  baseSha: string;
  headSha: string;
  sourceCreatedAt: string;
  input: Record<string, unknown>;
  collected: Record<string, unknown>;
  collectionStepId: string;
  collectionOutputHash: string;
  artifactHash: string;
  labelSetId: string;
  labelSetHash: string;
  labelSet: Record<string, unknown>;
}

export interface DatasetMetadata {
  id: string; name: string; status: "draft" | "frozen" | "retired"; version: number;
  splitPolicy: DatasetSplitPolicyV1; manifestHash?: string;
  caseCount: number; developmentCount: number; validationCount: number; holdoutCount: number;
  frozenAt?: string; contentPurgedAt?: string; createdAt: string;
}

export interface DatasetStorePort {
  create(principal: RunPrincipal, input: z.infer<typeof createDatasetSchema>): Promise<DatasetMetadata>;
  loadCaseSource(principal: RunPrincipal, datasetId: string, sourceRunId: string, labelSetId: string): Promise<DatasetCaseSource>;
  addCase(principal: RunPrincipal, datasetId: string, expectedVersion: number,
    source: DatasetCaseSource, fixture: DatasetFixtureV1): Promise<DatasetMetadata>;
  freeze(principal: RunPrincipal, datasetId: string, expectedVersion: number): Promise<DatasetMetadata>;
  read(principal: RunPrincipal, datasetId: string): Promise<DatasetMetadata>;
  readFixture(principal: RunPrincipal, datasetId: string, caseId: string): Promise<DatasetFixtureV1>;
}

export function assertDatasetPath(value: string): string { return safePath.parse(value); }
