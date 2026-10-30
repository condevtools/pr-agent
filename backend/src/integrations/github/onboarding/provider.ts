import type { PublicationBinding } from "../../../agent-runtime/authority/publication-authority.js";
import type { GitHubOnboardingIdentity } from "../../../agent-runtime/authority/github-onboarding.js";
import { getSharedGitHubProbot, validatePublicationCredentialOrigin } from "../../../agent-runtime/runtime/credentials.js";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const REQUIRED_PERMISSIONS = {
  checks: "write", contents: "write", issues: "write", metadata: "read", pull_requests: "write",
} as const;

interface GitHubApiClient {
  request(route: string, parameters?: Record<string, unknown>): Promise<{ data: unknown }>;
}

export interface GitHubOnboardingApp {
  id: number;
  slug: string;
  name: string;
}

export interface GitHubOnboardingRepository {
  identity: GitHubOnboardingIdentity;
  account: string;
  suspended: boolean;
}

export interface GitHubOnboardingProviderFactory {
  appClient(origin: string): Promise<GitHubApiClient>;
  installationClient(origin: string, installationId: number): Promise<GitHubApiClient>;
}

export class GitHubOnboardingProvider {
  constructor(private readonly clients: GitHubOnboardingProviderFactory = sharedProbotClients) {}

  async discover(origin: string, allowedAccountIds: readonly number[]): Promise<{
    app: GitHubOnboardingApp;
    repositories: GitHubOnboardingRepository[];
    suspendedInstallationIds: ReadonlySet<number>;
  }> {
    const appClient = await this.clients.appClient(origin);
    const app = parseApp((await appClient.request("GET /app")).data);
    const allowed = new Set(allowedAccountIds);
    const installations = await paginate(async (page) => parseList<Installation>(
      (await appClient.request("GET /app/installations", { per_page: PAGE_SIZE, page })).data,
      parseInstallation,
    ));
    const repositories: GitHubOnboardingRepository[] = [];
    const suspendedInstallationIds = new Set<number>();
    for (const installation of installations) {
      if (!allowed.has(installation.accountId)) continue;
      assertInstallation(app.id, installation);
      if (installation.suspended) {
        suspendedInstallationIds.add(installation.id);
        continue;
      }
      const installationClient = await this.clients.installationClient(origin, installation.id);
      const accessible = await paginate(async (page) => parseRepositoryPage(
        (await installationClient.request("GET /installation/repositories", {
          per_page: PAGE_SIZE, page,
        })).data,
      ));
      const actorId = await loadBotActorId(installationClient, app.slug);
      for (const repository of accessible) {
        repositories.push({
          identity: {
            origin: normalizedOrigin(origin), repository: repository.fullName.toLowerCase(), appId: app.id,
            installationId: installation.id, accountId: installation.accountId,
            repositoryId: repository.id, actorId,
          },
          account: installation.accountLogin,
          suspended: false,
        });
      }
    }
    return { app, repositories, suspendedInstallationIds };
  }

  async verifyRepository(origin: string, repository: string, allowedAccountIds: readonly number[]): Promise<{
    app: GitHubOnboardingApp;
    repository: GitHubOnboardingRepository;
  }> {
    const target = parseRepositoryName(repository);
    const appClient = await this.clients.appClient(origin);
    const app = parseApp((await appClient.request("GET /app")).data);
    const installation = parseInstallation((await appClient.request(
      "GET /repos/{owner}/{repo}/installation", { owner: target.owner, repo: target.repo },
    )).data);
    assertInstallation(app.id, installation);
    if (!allowedAccountIds.includes(installation.accountId)) throw new GitHubOnboardingAccessError();
    if (installation.suspended) throw new GitHubOnboardingAccessError("GitHub App installation is suspended");
    const installationClient = await this.clients.installationClient(origin, installation.id);
    const repo = parseRepository((await installationClient.request(
      "GET /repos/{owner}/{repo}", { owner: target.owner, repo: target.repo },
    )).data);
    if (repo.fullName.toLowerCase() !== `${target.owner}/${target.repo}`.toLowerCase()) {
      throw new GitHubOnboardingAccessError();
    }
    const actorId = await loadBotActorId(installationClient, app.slug);
    return {
      app,
      repository: {
        account: installation.accountLogin,
        suspended: false,
        identity: {
          origin: normalizedOrigin(origin), repository: repo.fullName.toLowerCase(), appId: app.id,
          installationId: installation.id, accountId: installation.accountId,
          repositoryId: repo.id, actorId,
        },
      },
    };
  }
}

export async function assertGitHubBindingAccess(
  binding: PublicationBinding,
  clients: GitHubOnboardingProviderFactory = sharedProbotClients,
): Promise<void> {
  if (binding.platform !== "github" || !binding.credentialRef.startsWith("github-app:")) return;
  validatePublicationCredentialOrigin(binding);
  if (binding.providerAccessState !== undefined && binding.providerAccessState !== "verified") {
    throw new GitHubOnboardingAccessError();
  }
  const installationId = positiveId(Number(binding.credentialRef.slice("github-app:".length)));
  const target = parseRepositoryName(binding.repository);
  const appClient = await clients.appClient(binding.origin);
  const app = parseApp((await appClient.request("GET /app")).data);
  const installation = parseInstallation((await appClient.request(
    "GET /repos/{owner}/{repo}/installation", { owner: target.owner, repo: target.repo },
  )).data);
  assertInstallation(app.id, installation);
  if (installation.id !== installationId || installation.suspended
      || (binding.githubAppId !== undefined && app.id !== binding.githubAppId)
      || (binding.githubAccountId !== undefined && installation.accountId !== binding.githubAccountId)) {
    throw new GitHubOnboardingAccessError();
  }
  const installationClient = await clients.installationClient(binding.origin, installationId);
  if (await loadBotActorId(installationClient, app.slug) !== binding.providerActorId) {
    throw new GitHubOnboardingAccessError();
  }
  const repository = parseRepository((await installationClient.request(
    "GET /repos/{owner}/{repo}", { owner: target.owner, repo: target.repo },
  )).data);
  if (repository.id !== binding.providerRepositoryId
      || repository.fullName.toLowerCase() !== binding.repository.toLowerCase()) {
    throw new GitHubOnboardingAccessError();
  }
}

export class GitHubOnboardingAccessError extends Error {
  readonly status = 403;
  constructor(message = "GitHub repository access could not be verified") {
    super(message);
    this.name = "GitHubOnboardingAccessError";
  }
}

const sharedProbotClients: GitHubOnboardingProviderFactory = {
  appClient: async (origin) => await getSharedGitHubProbot(origin).auth() as unknown as GitHubApiClient,
  installationClient: async (origin, installationId) =>
    await getSharedGitHubProbot(origin).auth(installationId) as unknown as GitHubApiClient,
};

interface Installation {
  id: number; appId: number; accountId: number; accountLogin: string; suspended: boolean;
  permissions: Record<string, unknown>;
}
interface Repository { id: number; fullName: string }

async function paginate<T>(load: (page: number) => Promise<T[]>): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const items = await load(page);
    result.push(...items);
    if (items.length < PAGE_SIZE) return result;
  }
  throw new Error("GitHub inventory exceeds the supported pagination bound");
}

function parseApp(value: unknown): GitHubOnboardingApp {
  const record = object(value);
  const id = positiveId(record.id);
  const slug = requiredString(record.slug, "GitHub App slug");
  const name = requiredString(record.name ?? slug, "GitHub App name");
  return { id, slug, name };
}

function parseInstallation(value: unknown): Installation {
  const record = object(value);
  const account = object(record.account);
  const permissions = object(record.permissions);
  return {
    id: positiveId(record.id), appId: positiveId(record.app_id), accountId: positiveId(account.id),
    accountLogin: requiredString(account.login, "GitHub account login"),
    suspended: record.suspended_at !== null && record.suspended_at !== undefined,
    permissions,
  };
}

function assertInstallation(appId: number, installation: Installation): void {
  if (installation.appId !== appId) throw new GitHubOnboardingAccessError();
  for (const [name, access] of Object.entries(REQUIRED_PERMISSIONS)) {
    if (installation.permissions[name] !== access) {
      throw new GitHubOnboardingAccessError("GitHub App installation permissions are incomplete");
    }
  }
}

function parseRepositoryPage(value: unknown): Repository[] {
  const record = object(value);
  if (!Array.isArray(record.repositories)) throw new Error("Invalid GitHub repository inventory response");
  return record.repositories.map(parseRepository);
}

function parseRepository(value: unknown): Repository {
  const record = object(value);
  return { id: positiveId(record.id), fullName: requiredString(record.full_name, "GitHub repository name") };
}

async function loadBotActorId(client: GitHubApiClient, appSlug: string): Promise<number> {
  const login = `${appSlug}[bot]`;
  const actor = object((await client.request("GET /users/{username}", { username: login })).data);
  if (requiredString(actor.login, "GitHub App bot login").toLowerCase() !== login.toLowerCase()
      || actor.type !== "Bot") throw new GitHubOnboardingAccessError("GitHub App bot identity is unavailable");
  return positiveId(actor.id);
}

function parseRepositoryName(value: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value.trim());
  if (!match) throw new GitHubOnboardingAccessError("Repository must use owner/name format");
  return { owner: match[1]!, repo: match[2]! };
}

function parseList<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("Invalid GitHub inventory response");
  return value.map(parse);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid GitHub API response");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${label}`);
  return value.trim();
}

function positiveId(value: unknown): number {
  const id = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid GitHub identity");
  return id;
}

function normalizedOrigin(value: string): string { return value.trim().replace(/\/$/u, ""); }
