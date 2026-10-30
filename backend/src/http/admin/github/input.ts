import { z } from "zod";

const repository = z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(201);

export const enrollGitHubRepositorySchema = z.object({
  repository,
  confirmPublisherStopped: z.literal(true),
}).strict();

export const revalidateGitHubRepositorySchema = enrollGitHubRepositorySchema.extend({
  expectedAccessVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export type EnrollGitHubRepositoryInput = z.infer<typeof enrollGitHubRepositorySchema>;
export type RevalidateGitHubRepositoryInput = z.infer<typeof revalidateGitHubRepositorySchema>;
