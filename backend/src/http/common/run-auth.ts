import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { RUN_PERMISSIONS, RunControlError, type RunPrincipal } from "../../agent-runtime/runs/control-contracts.js";

const credentialFields = {
  subjectId: z.string().min(1).max(200), actorType: z.enum(["user", "service"]),
  tokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  keyId: z.string().min(1).max(100).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  notBefore: z.string().datetime({ offset: true }).optional(),
  disabled: z.boolean().optional(),
};
const runPrincipalSchema = z.object({
  ...credentialFields,
  tenantId: z.string().uuid(), integrationId: z.string().uuid(),
  permissions: z.array(z.enum(RUN_PERMISSIONS)).min(1).max(RUN_PERMISSIONS.length)
    .refine((items) => new Set(items).size === items.length, "Duplicate permissions"),
}).strict();
const repositoryAdminPrincipalSchema = z.object({
  ...credentialFields,
  principalType: z.literal("repository_admin"), tenantId: z.string().uuid(),
  githubAccountIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(1000)
    .refine((items) => new Set(items).size === items.length, "Duplicate GitHub account IDs"),
  permissions: z.tuple([z.literal("repositories:manage")]),
}).strict();
const principalSchema = z.union([runPrincipalSchema, repositoryAdminPrincipalSchema]);

export interface RepositoryAdminPrincipal {
  principalType: "repository_admin";
  subjectId: string;
  actorType: "user" | "service";
  tenantId: string;
  githubAccountIds: readonly number[];
  permissions: readonly ["repositories:manage"];
}

type AuthenticatedPrincipal = RunPrincipal | RepositoryAdminPrincipal;
type StoredPrincipal = AuthenticatedPrincipal & { digest: Buffer; keyId?: string;
  expiresAt?: string; notBefore?: string; disabled?: boolean };

/** Reloadable hashed credentials; invalid replacement configuration fails closed. */
export class RunApiAuthenticator {
  private generation = 0;
  private readonly issued = new WeakMap<object, { generation: number; expiresAt?: number }>();
  private principals: StoredPrincipal[] = [];

  constructor(configuration: string | undefined = process.env.HARNESS_API_PRINCIPALS_JSON) {
    this.reload(configuration);
  }

  reload(configuration: string | undefined): void {
    this.generation += 1;
    this.principals = [];
    if (configuration === undefined || !configuration.trim()) {
      this.principals = [];
      return;
    }
    try {
      const records = z.array(principalSchema).min(1).max(1000).parse(JSON.parse(configuration));
      if (new Set(records.map((record) => record.tokenSha256)).size !== records.length) throw new Error("Duplicate digest");
      const keyIds = records.flatMap((record) => record.keyId ? [record.keyId] : []);
      if (new Set(keyIds).size !== keyIds.length) throw new Error("Duplicate key id");
      if (records.some((record) => record.notBefore && record.expiresAt
          && Date.parse(record.notBefore) >= Date.parse(record.expiresAt))) throw new Error("Invalid credential lifetime");
      const accountOwners = new Map<number, string>();
      for (const record of records) {
        if (!("principalType" in record)) continue;
        for (const accountId of record.githubAccountIds) {
          const owner = accountOwners.get(accountId);
          if (owner && owner !== record.tenantId) throw new Error("Conflicting GitHub account tenant");
          accountOwners.set(accountId, record.tenantId);
        }
      }
      this.principals = records.map(({ tokenSha256, ...principal }) => ({ ...principal, digest: Buffer.from(tokenSha256, "hex") }));
    } catch {
      throw new Error("HARNESS_API_PRINCIPALS_JSON must contain strict scoped principals with unique SHA-256 token digests");
    }
  }

  authenticate(authorization: unknown): RunPrincipal {
    const principal = this.authenticateAny(authorization);
    if (isRepositoryAdminPrincipal(principal)) {
      throw new RunControlError("FORBIDDEN", 403, "Repository administrator credentials cannot access Run APIs");
    }
    return principal;
  }

  authenticateRepositoryAdmin(authorization: unknown): RepositoryAdminPrincipal {
    const principal = this.authenticateAny(authorization);
    if (!isRepositoryAdminPrincipal(principal)) {
      throw new RunControlError("FORBIDDEN", 403, "Repository administrator permission is required");
    }
    return principal;
  }

  private authenticateAny(authorization: unknown): AuthenticatedPrincipal {
    if (this.principals.length === 0) throw new RunControlError("RUN_API_DISABLED", 503, "Run API authentication is not configured");
    if (typeof authorization !== "string" || authorization.length > 4096 || !/^Bearer [A-Za-z0-9._~+/-]+=*$/.test(authorization)) {
      throw new RunControlError("UNAUTHORIZED", 401, "A bearer credential is required");
    }
    const digest = createHash("sha256").update(authorization.slice(7)).digest();
    let matched: AuthenticatedPrincipal | undefined;
    let expiry: number | undefined;
    // Compare all fixed-size digests; avoid an early return revealing registry position.
    const now = Date.now();
    for (const { digest: expected, keyId: _keyId, expiresAt, notBefore, disabled, ...principal } of this.principals) {
      const sameCredential = timingSafeEqual(digest, expected);
      if (sameCredential && !disabled && (!expiresAt || Date.parse(expiresAt) > now)
          && (!notBefore || Date.parse(notBefore) <= now)) {
        matched = principal;
        expiry = expiresAt ? Date.parse(expiresAt) : undefined;
      }
    }
    if (!matched) throw new RunControlError("UNAUTHORIZED", 401, "The bearer credential is invalid");
    this.issued.set(matched, { generation: this.generation, expiresAt: expiry });
    return matched;
  }

  assertCurrent(principal: AuthenticatedPrincipal): void {
    const grant = this.issued.get(principal);
    if (!grant || grant.generation !== this.generation
        || (grant.expiresAt !== undefined && grant.expiresAt <= Date.now())) {
      throw new RunControlError("UNAUTHORIZED", 401, "The bearer credential is no longer valid");
    }
  }
}

function isRepositoryAdminPrincipal(principal: AuthenticatedPrincipal): principal is RepositoryAdminPrincipal {
  return "principalType" in principal && principal.principalType === "repository_admin";
}
