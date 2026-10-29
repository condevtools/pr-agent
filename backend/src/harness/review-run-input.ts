import { z } from "zod";

const text = z.string().max(100_000);
const sha = z.string().min(1).max(128);

export const reviewRunInputSchema = z.object({
  schemaVersion: z.literal(1), workflow: z.literal("review.single.v1"),
  platform: z.enum(["github", "gitlab"]),
  target: z.object({
    origin: z.string().url(), repository: z.string().min(1).max(512),
    number: z.number().int().positive(), providerRepositoryId: z.number().int().positive(),
  }).strict(),
  source: z.object({ key: z.string().min(1).max(1024), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  revision: z.object({ baseSha: sha, headSha: sha }).strict(),
  mode: z.enum(["report", "comment"]),
  trigger: z.enum(["merged", "comment-command", "mention-command", "describe-command", "pr-opened", "pr-edited", "pr-synchronize", "gitlab-webhook"]),
  options: z.object({
    customRules: z.array(text).max(100), includeCiChecks: z.boolean(),
    enableSecretScan: z.boolean(), secretScanCustomPatterns: z.array(z.string().max(4096)).max(100),
    enableAutoLabel: z.boolean(),
  }).strict(),
  presentation: z.object({
    title: text, body: text, author: z.string().max(512),
    baseBranch: z.string().max(1024), headBranch: z.string().max(1024),
    webUrl: z.string().max(4096), draft: z.boolean(),
  }).strict(),
}).strict();

export type ReviewRunInput = z.infer<typeof reviewRunInputSchema>;
