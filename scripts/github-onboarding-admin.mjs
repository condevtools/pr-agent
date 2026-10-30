#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_EXPIRY_DAYS = 30;
const MAX_EXPIRY_DAYS = 365;
const GITHUB_API_BASE_URL = "https://api.github.com";

export function parseArguments(argv) {
  if (argv[0] === "--") argv = argv.slice(1);
  const values = new Map();
  const allowed = new Set(["account", "account-id", "tenant", "subject", "expires-in-days"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (!argument.startsWith("--") || !allowed.has(argument.slice(2))) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const name = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    if (values.has(name)) throw new Error(`Duplicate argument: --${name}`);
    values.set(name, value);
    index += 1;
  }

  const account = values.get("account");
  const rawAccountId = values.get("account-id");
  if ((account ? 1 : 0) + (rawAccountId ? 1 : 0) !== 1) {
    throw new Error("Provide exactly one of --account or --account-id");
  }
  if (account && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/u.test(account)) {
    throw new Error("--account must be a GitHub account login");
  }

  const accountId = rawAccountId === undefined ? undefined : parsePositiveInteger(rawAccountId, "--account-id");
  const tenantId = values.get("tenant");
  if (tenantId && !isUuid(tenantId)) throw new Error("--tenant must be a UUID");
  const subjectId = values.get("subject");
  if (subjectId !== undefined && (subjectId.trim().length === 0 || subjectId.length > 200)) {
    throw new Error("--subject must contain 1 to 200 characters");
  }
  const expiresInDays = values.has("expires-in-days")
    ? parsePositiveInteger(values.get("expires-in-days"), "--expires-in-days")
    : DEFAULT_EXPIRY_DAYS;
  if (expiresInDays > MAX_EXPIRY_DAYS) {
    throw new Error(`--expires-in-days cannot exceed ${MAX_EXPIRY_DAYS}`);
  }

  return { help: false, account, accountId, tenantId, subjectId: subjectId?.trim(), expiresInDays };
}

export async function createAdminConfiguration(options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const now = dependencies.now ?? new Date();
  const randomBytesImpl = dependencies.randomBytesImpl ?? randomBytes;
  const randomUuidImpl = dependencies.randomUuidImpl ?? randomUUID;
  const account = options.account
    ? await resolveGitHubAccount(options.account, { fetchImpl, signal: dependencies.signal })
    : { id: options.accountId, login: undefined, type: undefined };
  if (!Number.isSafeInteger(account.id) || account.id <= 0) throw new Error("GitHub account ID is invalid");

  const tenantId = options.tenantId ?? randomUuidImpl();
  if (!isUuid(tenantId)) throw new Error("Generated tenant ID is invalid");
  const bearerToken = randomBytesImpl(32).toString("base64url");
  if (!bearerToken) throw new Error("Bearer token generation failed");
  const expiresAt = new Date(now.getTime() + options.expiresInDays * 86_400_000).toISOString();
  const subjectId = options.subjectId ?? `github-admin:${account.login ?? account.id}`;
  const principal = {
    principalType: "repository_admin",
    subjectId,
    actorType: "user",
    tenantId,
    githubAccountIds: [account.id],
    permissions: ["repositories:manage"],
    tokenSha256: createHash("sha256").update(bearerToken).digest("hex"),
    keyId: `github-onboarding-${randomUuidImpl()}`,
    expiresAt,
  };

  return {
    account,
    bearerToken,
    principal,
    configuration: {
      FEATURE_GITHUB_ONBOARDING: "on",
      appendPrincipalToHARNESS_API_PRINCIPALS_JSON: principal,
    },
  };
}

export async function resolveGitHubAccount(login, { fetchImpl = globalThis.fetch, signal } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable in this Node.js runtime");
  const response = await fetchImpl(`${GITHUB_API_BASE_URL}/users/${encodeURIComponent(login)}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "pr-agent-github-onboarding-admin",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    if (response.status === 404) throw new Error(`GitHub account '${login}' was not found`);
    throw new Error(`GitHub account lookup failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!Number.isSafeInteger(payload?.id) || payload.id <= 0 || typeof payload.login !== "string") {
    throw new Error("GitHub returned an invalid account response");
  }
  return { id: payload.id, login: payload.login, type: typeof payload.type === "string" ? payload.type : undefined };
}

function parsePositiveInteger(value, name) {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} exceeds the safe integer range`);
  return parsed;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function usage() {
  return `Create a time-limited repository-administrator credential for GitHub onboarding.

Usage:
  pnpm github:admin:create -- --account <github-login> [options]
  pnpm github:admin:create -- --account-id <numeric-id> [options]

Options:
  --tenant <uuid>           Reuse an existing tenant (otherwise a UUID is generated)
  --subject <audit-label>   Credential subject (default: github-admin:<account>)
  --expires-in-days <days>  Credential lifetime, 1-${MAX_EXPIRY_DAYS} (default: ${DEFAULT_EXPIRY_DAYS})
  --account-id <id>         Offline alternative to the public GitHub account lookup
  --help                    Show this help

The command prints a one-time bearer token and a hashed principal. It does not edit .env or contact the deployment.`;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const output = await createAdminConfiguration(options);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Credential generation failed"}\n\n${usage()}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) await main();
