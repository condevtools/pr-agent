import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { readFileSync, statSync } from "node:fs";

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
const principalSchema = runPrincipalSchema;

type StoredPrincipal = RunPrincipal & { digest: Buffer; keyId?: string;
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
      this.principals = records.map(({ tokenSha256, ...principal }) => ({ ...principal, digest: Buffer.from(tokenSha256, "hex") }));
    } catch {
      throw new Error("HARNESS_API_PRINCIPALS_JSON must contain strict scoped principals with unique SHA-256 token digests");
    }
  }

  authenticate(authorization: unknown): RunPrincipal {
    return this.authenticateAny(authorization);
  }

  private authenticateAny(authorization: unknown): RunPrincipal {
    if (this.principals.length === 0) throw new RunControlError("RUN_API_DISABLED", 503, "Run API authentication is not configured");
    if (typeof authorization !== "string" || authorization.length > 4096 || !/^Bearer [A-Za-z0-9._~+/-]+=*$/.test(authorization)) {
      throw new RunControlError("UNAUTHORIZED", 401, "A bearer credential is required");
    }
    const digest = createHash("sha256").update(authorization.slice(7)).digest();
    let matched: RunPrincipal | undefined;
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

  assertCurrent(principal: RunPrincipal): void {
    const grant = this.issued.get(principal);
    if (!grant || grant.generation !== this.generation
        || (grant.expiresAt !== undefined && grant.expiresAt <= Date.now())) {
      throw new RunControlError("UNAUTHORIZED", 401, "The bearer credential is no longer valid");
    }
  }

  /** Revalidates a persisted job's actor grant; never accepts a bearer token from the job. */
  assertDelegated(principal: RunPrincipal): void {
    const now = Date.now();
    const current = this.principals.some((grant) => !grant.disabled
      && (!grant.expiresAt || Date.parse(grant.expiresAt) > now)
      && (!grant.notBefore || Date.parse(grant.notBefore) <= now)
      && grant.subjectId === principal.subjectId && grant.actorType === principal.actorType
      && grant.tenantId === principal.tenantId && grant.integrationId === principal.integrationId
      && principal.permissions.every((permission) => grant.permissions.includes(permission)));
    if (!current) throw new RunControlError("UNAUTHORIZED", 401, "The delegated actor grant is no longer valid");
  }
}

export function readPrincipalConfiguration(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env.HARNESS_API_PRINCIPALS_FILE?.trim();
  if (!path) return env.HARNESS_API_PRINCIPALS_JSON;
  if (env.HARNESS_API_PRINCIPALS_JSON?.trim()) throw new Error("Configure one Run API credential source");
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Invalid Run API credential file");
  return readFileSync(path, "utf8");
}
