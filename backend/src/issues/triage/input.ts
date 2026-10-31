import { z } from "zod";
import { fingerprint } from "../../agent-runtime/versions.js";

const id = z.number().int().positive().safe();
export const issueTriageRunInputSchema = z.object({
  schemaVersion: z.literal(1), workflow: z.literal("issue.triage.v1"), platform: z.literal("github"),
  target: z.object({ origin: z.string().url(), repository: z.string().min(1).max(512),
    providerRepositoryId: id, number: id, issueId: id }).strict(),
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
  issue: z.object({ id, number: id, title: z.string().max(1024), body: z.string().max(65_536).nullable(),
    state: z.literal("open"), user: z.object({ id, login: z.string().min(1).max(512),
      type: z.string().max(64).optional() }).strict() }).strict(),
  options: z.object({ autoLabels: z.boolean(), locale: z.enum(["zh", "en"]) }).strict(),
}).strict();
export type IssueTriageRunInput = z.infer<typeof issueTriageRunInputSchema>;

/** Content identity deliberately excludes delivery IDs, policies, labels and comment activity. */
export function issueTriageIdentity(bindingId: string, input: IssueTriageRunInput) {
  const key = `issue:${input.target.issueId}:${input.revision}`;
  return { scope: `issue.triage.v1:${bindingId}`, key,
    hash: fingerprint({ bindingId, platform: input.platform, target: input.target, revision: input.revision }) };
}
