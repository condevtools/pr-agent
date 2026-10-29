import { Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";

import { DatasetStore } from "../../evolution/dataset-store.js";
import { addDatasetCaseSchema, createDatasetSchema, freezeDatasetSchema } from "../../evolution/dataset-contracts.js";
import { buildDatasetFixture, type DatasetRepositoryAdapter } from "../../evolution/dataset-fixture.js";
import { GitHubRepositoryReadAdapter } from "../../integrations/github/github-repository-read-tools.js";
import { GitLabRepositoryReadAdapter } from "../../integrations/gitlab/gitlab-repository-read-tools.js";
import { RunControlError } from "../../harness/run-control-contracts.js";
import { getHarnessServices, resolvePublicationRuntime } from "../../harness/runtime.js";
import { RunsService } from "../harness/runs.service.js";

const uuid = z.string().uuid();

@Injectable()
export class DatasetsService {
  constructor(@Inject(RunsService) private readonly runs: RunsService) {}

  authenticate(request: Request) { return this.runs.authenticate(request); }

  async create(request: Request, body: unknown) {
    const principal = this.authenticate(request);
    return (await this.store()).create(principal, createDatasetSchema.parse(body));
  }

  async addCase(request: Request, datasetId: string, body: unknown) {
    const principal = this.authenticate(request); uuid.parse(datasetId);
    const input = addDatasetCaseSchema.parse(body);
    const store = await this.store();
    const source = await store.loadCaseSource(principal, datasetId, input.sourceRunId, input.labelSetId);
    const runtime = await resolvePublicationRuntime({ platform: source.platform, origin: source.origin,
      repository: source.repository });
    if (!runtime || runtime.binding.id !== source.integrationId
        || runtime.binding.providerRepositoryId !== source.providerRepositoryId) {
      throw new RunControlError("SOURCE_AUTHORITY_UNAVAILABLE", 409, "Source repository authority is unavailable");
    }
    const token = await runtime.resolveCredential();
    const adapter: DatasetRepositoryAdapter = source.platform === "gitlab"
      ? new GitLabRepositoryReadAdapter({ baseUrl: source.origin, token,
        projectId: source.providerRepositoryId, headSha: source.headSha })
      : githubAdapter(source.origin, source.repository, source.headSha, token);
    const fixture = await buildDatasetFixture(source, adapter);
    return store.addCase(principal, datasetId, input.expectedVersion, source, fixture);
  }

  async freeze(request: Request, datasetId: string, body: unknown) {
    const principal = this.authenticate(request); uuid.parse(datasetId);
    const input = freezeDatasetSchema.parse(body);
    return (await this.store()).freeze(principal, datasetId, input.expectedVersion);
  }

  async read(request: Request, datasetId: string) {
    const principal = this.authenticate(request); uuid.parse(datasetId);
    return (await this.store()).read(principal, datasetId);
  }

  async readFixture(request: Request, datasetId: string, caseId: string) {
    const principal = this.authenticate(request); uuid.parse(datasetId); uuid.parse(caseId);
    return (await this.store()).readFixture(principal, datasetId, caseId);
  }

  private async store(): Promise<DatasetStore> {
    return new DatasetStore((await getHarnessServices()).db);
  }
}

function githubAdapter(origin: string, repository: string, headSha: string, token: string): DatasetRepositoryAdapter {
  const [owner, repo, extra] = repository.split("/");
  if (!owner || !repo || extra) throw new RunControlError("SOURCE_REPOSITORY_INVALID", 409, "GitHub repository identity is invalid");
  return new GitHubRepositoryReadAdapter({ apiBaseUrl: origin, token, owner, repo, headSha });
}
