import type { PublicationBinding } from "../../../agent-runtime/authority/publication-authority.js";
import type { GitHubOnboardingIdentity } from "../../../agent-runtime/authority/github-onboarding.js";
import { getSharedGitHubProbot, validatePublicationCredentialOrigin } from "../../../agent-runtime/runtime/credentials.js";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const DEFAULT_INVENTORY_DEADLINE_MS = 5 * 60_000;
const DEFAULT_INVENTORY_ATTEMPTS = 3;
const DEFAULT_INVENTORY_BACKOFF_MS = 400;
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

interface GitHubInstallationInventoryBase {
  id: number;
  appId: number;
  account: { id: number; login: string };
  permissions: Readonly<Record<string, unknown>>;
}

export type GitHubInstallationInventory =
  | GitHubInstallationInventoryBase & { status: "active"; accessEligible: true }
  | GitHubInstallationInventoryBase & {
    status: "suspended" | "permissions_incomplete";
    accessEligible: false;
    restrictionReason: "suspended" | "permissions_incomplete";
  };

export interface GitHubInstallationDiscovery {
  app: GitHubOnboardingApp;
  installations: GitHubInstallationInventory[];
}

export interface GitHubInstallationSnapshotRepository extends GitHubOnboardingRepository {
  fullName: string;
  suspended: false;
}

export interface GitHubInstallationBotIdentity { id: number; login: string }

export interface GitHubInventoryRequestOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
}

export type GitHubInstallationSnapshot =
  | {
    complete: true;
    status: "active";
    app: GitHubOnboardingApp;
    installation: Extract<GitHubInstallationInventory, { status: "active" }>;
    account: { id: number; login: string };
    bot: GitHubInstallationBotIdentity;
    repositories: GitHubInstallationSnapshotRepository[];
    completedAt: string;
  }
  | {
    complete: true;
    status: "suspended" | "permissions_incomplete";
    app: GitHubOnboardingApp;
    installation: GitHubInstallationInventory;
    account: { id: number; login: string };
    bot: null;
    repositories: readonly [];
    completedAt: string;
  }
  | {
    complete: true;
    status: "deleted";
    app: GitHubOnboardingApp;
    installation: { id: number; status: "deleted" };
    account: null;
    bot: null;
    repositories: readonly [];
    completedAt: string;
  };

export interface GitHubOnboardingProviderFactory {
  appClient(origin: string): Promise<GitHubApiClient>;
  installationClient(origin: string, installationId: number): Promise<GitHubApiClient>;
}

export class GitHubOnboardingProvider {
  constructor(private readonly clients: GitHubOnboardingProviderFactory = sharedProbotClients) {}

  async discoverInstallations(
    origin: string,
    options: GitHubInventoryRequestOptions = {},
  ): Promise<GitHubInstallationDiscovery> {
    const operation = inventoryOperation(options);
    const appClient = await abortable(this.clients.appClient(origin), operation.signal);
    const app = parseApp((await inventoryRequest(appClient, "GET /app", {}, operation)).data);
    const installations = await paginateComplete(
      async (page) => parseList<Installation>((await inventoryRequest(appClient, "GET /app/installations", {
        per_page: PAGE_SIZE, page,
      }, operation)).data, parseInstallation),
      (installation) => installation.id,
    );
    return {
      app,
      installations: installations.map((installation) => {
        assertInstallationApp(app.id, installation);
        return installationInventory(installation);
      }),
    };
  }

  async installationSnapshot(
    origin: string,
    installationId: number,
    options: GitHubInventoryRequestOptions = {},
  ): Promise<GitHubInstallationSnapshot> {
    const requestedInstallationId = positiveId(installationId);
    const operation = inventoryOperation(options);
    const appClient = await abortable(this.clients.appClient(origin), operation.signal);
    const app = parseApp((await inventoryRequest(appClient, "GET /app", {}, operation)).data);
    let installation: Installation;
    try {
      installation = parseInstallation((await inventoryRequest(
        appClient,
        "GET /app/installations/{installation_id}",
        { installation_id: requestedInstallationId },
        operation,
      )).data);
    } catch (error) {
      if (error instanceof GitHubOnboardingInventoryError && error.status === 404) {
        return {
          complete: true, status: "deleted", app,
          installation: { id: requestedInstallationId, status: "deleted" },
          account: null, bot: null, repositories: [], completedAt: new Date().toISOString(),
        };
      }
      throw error;
    }
    if (installation.id !== requestedInstallationId) {
      throw new GitHubOnboardingAccessError("GitHub App installation identity does not match the request");
    }
    assertInstallationApp(app.id, installation);
    const inventory = installationInventory(installation);
    if (inventory.status !== "active") {
      return {
        complete: true, status: inventory.status, app, installation: inventory,
        account: inventory.account, bot: null, repositories: [], completedAt: new Date().toISOString(),
      };
    }

    const installationClient = await abortable(
      this.clients.installationClient(origin, requestedInstallationId), operation.signal,
    );
    const repositories = await paginateComplete(
      async (page) => parseRepositoryPage((await inventoryRequest(
        installationClient,
        "GET /installation/repositories",
        { per_page: PAGE_SIZE, page },
        operation,
      )).data),
      (repository) => repository.id,
    );
    const bot = await loadBotActor(installationClient, app.slug, operation);
    const normalized = normalizedOrigin(origin);
    return {
      complete: true,
      status: "active",
      app,
      installation: inventory,
      account: inventory.account,
      bot,
      repositories: repositories.map((repository) => ({
        fullName: repository.fullName,
        account: inventory.account.login,
        suspended: false,
        identity: {
          origin: normalized,
          repository: repository.fullName.toLowerCase(),
          appId: app.id,
          installationId: inventory.id,
          accountId: inventory.account.id,
          repositoryId: repository.id,
          actorId: bot.id,
        },
      })),
      completedAt: new Date().toISOString(),
    };
  }

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

export class GitHubOnboardingInventoryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GitHubOnboardingInventoryError";
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

interface InventoryOperation {
  signal: AbortSignal;
  maxAttempts: number;
  backoffMs: number;
}

async function paginate<T>(load: (page: number) => Promise<T[]>): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const items = await load(page);
    result.push(...items);
    if (items.length < PAGE_SIZE) return result;
  }
  throw new Error("GitHub inventory exceeds the supported pagination bound");
}

async function paginateComplete<T>(
  load: (page: number) => Promise<T[]>,
  identity: (item: T) => number,
): Promise<T[]> {
  const result: T[] = [];
  const identities = new Set<number>();
  for (let page = 1; page <= MAX_PAGES + 1; page += 1) {
    const items = await load(page);
    if (page === MAX_PAGES + 1 && items.length > 0) {
      throw new GitHubOnboardingInventoryError(
        "GitHub inventory exceeds the supported 10,000 repository bound", false,
      );
    }
    for (const item of items) {
      const id = identity(item);
      if (identities.has(id)) {
        throw new GitHubOnboardingInventoryError("GitHub inventory repeated an identity across pages", false);
      }
      identities.add(id);
      result.push(item);
    }
    if (items.length < PAGE_SIZE) return result;
  }
  throw new GitHubOnboardingInventoryError("GitHub inventory did not provide terminal pagination evidence", false);
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
  assertInstallationApp(appId, installation);
  for (const [name, access] of Object.entries(REQUIRED_PERMISSIONS)) {
    if (installation.permissions[name] !== access) {
      throw new GitHubOnboardingAccessError("GitHub App installation permissions are incomplete");
    }
  }
}

function assertInstallationApp(appId: number, installation: Installation): void {
  if (installation.appId !== appId) throw new GitHubOnboardingAccessError();
}

function installationInventory(installation: Installation): GitHubInstallationInventory {
  const permissionsComplete = Object.entries(REQUIRED_PERMISSIONS).every(
    ([name, access]) => installation.permissions[name] === access,
  );
  const status = installation.suspended
    ? "suspended" as const
    : permissionsComplete ? "active" as const : "permissions_incomplete" as const;
  const base = {
    id: installation.id,
    appId: installation.appId,
    account: { id: installation.accountId, login: installation.accountLogin },
    permissions: { ...installation.permissions },
  };
  return status === "active"
    ? { ...base, status, accessEligible: true }
    : { ...base, status, accessEligible: false, restrictionReason: status };
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

async function loadBotActor(
  client: GitHubApiClient,
  appSlug: string,
  operation: InventoryOperation,
): Promise<GitHubInstallationBotIdentity> {
  const login = `${appSlug}[bot]`;
  const actor = object((await inventoryRequest(
    client, "GET /users/{username}", { username: login }, operation,
  )).data);
  const actualLogin = requiredString(actor.login, "GitHub App bot login");
  if (actualLogin.toLowerCase() !== login.toLowerCase() || actor.type !== "Bot") {
    throw new GitHubOnboardingAccessError("GitHub App bot identity is unavailable");
  }
  return { id: positiveId(actor.id), login: actualLogin };
}

function inventoryOperation(options: GitHubInventoryRequestOptions): InventoryOperation {
  const deadlineMs = boundedInteger(options.deadlineMs ?? DEFAULT_INVENTORY_DEADLINE_MS, 1, 60 * 60_000,
    "GitHub inventory deadline");
  const maxAttempts = boundedInteger(options.maxAttempts ?? DEFAULT_INVENTORY_ATTEMPTS, 1, 10,
    "GitHub inventory attempts");
  const backoffMs = boundedInteger(options.backoffMs ?? DEFAULT_INVENTORY_BACKOFF_MS, 0, 60_000,
    "GitHub inventory backoff");
  const deadline = AbortSignal.timeout(deadlineMs);
  return {
    signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
    maxAttempts,
    backoffMs,
  };
}

async function inventoryRequest(
  client: GitHubApiClient,
  route: string,
  parameters: Record<string, unknown>,
  operation: InventoryOperation,
): Promise<{ data: unknown }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= operation.maxAttempts; attempt += 1) {
    assertNotAborted(operation.signal);
    try {
      return await abortable(client.request(route, {
        ...parameters,
        request: { signal: operation.signal },
      }), operation.signal);
    } catch (error) {
      if (operation.signal.aborted) throw abortReason(operation.signal);
      lastError = error;
      const status = errorStatus(error);
      const retryable = isTemporaryStatus(status);
      if (!retryable || attempt === operation.maxAttempts) {
        throw new GitHubOnboardingInventoryError(
          `GitHub inventory request failed for ${route}`,
          retryable,
          status,
          { cause: error },
        );
      }
      await cancellableDelay(operation.backoffMs * 2 ** (attempt - 1), operation.signal);
    }
  }
  throw lastError;
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  assertNotAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function cancellableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms === 0) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("GitHub inventory request aborted", "AbortError");
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function isTemporaryStatus(status: number | undefined): boolean {
  return status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599);
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${label}`);
  return value;
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
