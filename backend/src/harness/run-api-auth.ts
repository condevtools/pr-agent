import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { RUN_PERMISSIONS, RunControlError, type RunPrincipal } from "./run-control-contracts.js";

const principalSchema = z.object({
  subjectId: z.string().min(1).max(200), actorType: z.enum(["user", "service"]),
  tokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  tenantId: z.string().uuid(), integrationId: z.string().uuid(),
  permissions: z.array(z.enum(RUN_PERMISSIONS)).min(1).max(RUN_PERMISSIONS.length)
    .refine((items) => new Set(items).size === items.length, "Duplicate permissions"),
}).strict();

/** Static credential configuration: revoking a token requires a process restart. */
export class RunApiAuthenticator {
  private readonly principals: Array<RunPrincipal & { digest: Buffer }>;

  constructor(configuration: string | undefined = process.env.HARNESS_API_PRINCIPALS_JSON) {
    if (configuration === undefined || !configuration.trim()) {
      this.principals = [];
      return;
    }
    try {
      const records = z.array(principalSchema).min(1).max(1000).parse(JSON.parse(configuration));
      if (new Set(records.map((record) => record.tokenSha256)).size !== records.length) throw new Error("Duplicate digest");
      this.principals = records.map(({ tokenSha256, ...principal }) => ({ ...principal, digest: Buffer.from(tokenSha256, "hex") }));
    } catch {
      throw new Error("HARNESS_API_PRINCIPALS_JSON must contain strict scoped principals with unique SHA-256 token digests");
    }
  }

  authenticate(authorization: unknown): RunPrincipal {
    if (this.principals.length === 0) throw new RunControlError("RUN_API_DISABLED", 503, "Run API authentication is not configured");
    if (typeof authorization !== "string" || authorization.length > 4096 || !/^Bearer [A-Za-z0-9._~+/-]+=*$/.test(authorization)) {
      throw new RunControlError("UNAUTHORIZED", 401, "A bearer credential is required");
    }
    const digest = createHash("sha256").update(authorization.slice(7)).digest();
    let matched: RunPrincipal | undefined;
    // Compare all fixed-size digests; avoid an early return revealing registry position.
    for (const { digest: expected, ...principal } of this.principals) {
      if (timingSafeEqual(digest, expected)) matched = principal;
    }
    if (!matched) throw new RunControlError("UNAUTHORIZED", 401, "The bearer credential is invalid");
    return matched;
  }
}
