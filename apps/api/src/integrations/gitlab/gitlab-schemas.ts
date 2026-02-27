/**
 * Zod schemas for GitLab webhook payload validation.
 */

import { z } from "zod";
import { BadWebhookRequestError } from "@mr-agent/core";

export const gitlabProjectSchema = z.object({
  id: z.number(),
  web_url: z.string(),
  name: z.string().optional(),
  path_with_namespace: z.string().optional(),
});

export const gitlabMrWebhookPayloadSchema = z.object({
  object_kind: z.string().optional(),
  event_type: z.string().optional(),
  user: z
    .object({
      username: z.string().optional(),
    })
    .optional(),
  project: gitlabProjectSchema,
  object_attributes: z.object({
    iid: z.number().int().positive(),
    action: z.string().optional(),
    state: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    url: z.string().optional(),
    source_branch: z.string().optional(),
    target_branch: z.string().optional(),
    draft: z.boolean().optional(),
    work_in_progress: z.boolean().optional(),
    last_commit: z
      .object({
        id: z.string().optional(),
      })
      .optional(),
  }),
  merge_request: z
    .object({
      iid: z.number().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      work_in_progress: z.boolean().optional(),
      draft: z.boolean().optional(),
      source_branch: z.string().optional(),
      target_branch: z.string().optional(),
      url: z.string().optional(),
      state: z.string().optional(),
    })
    .optional(),
  repository: z
    .object({
      name: z.string().optional(),
    })
    .optional(),
});

export const gitlabNoteWebhookPayloadSchema = z.object({
  object_kind: z.string().optional(),
  event_type: z.string().optional(),
  user: z
    .object({
      username: z.string().optional(),
    })
    .optional(),
  project: gitlabProjectSchema,
  object_attributes: z.object({
    note: z.string().optional(),
    action: z.string().optional(),
    noteable_type: z.string().optional(),
    noteable_iid: z.union([z.number(), z.string()]).optional(),
    url: z.string().optional(),
  }),
  merge_request: z
    .object({
      iid: z.number().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      source_branch: z.string().optional(),
      target_branch: z.string().optional(),
      url: z.string().optional(),
      state: z.string().optional(),
    })
    .optional(),
});

export function parseGitLabPayload<T>(
  schema: z.ZodType<T>,
  payload: unknown,
  eventKind: string,
): T {
  const parsed = schema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
  }
  const firstIssue = parsed.error.issues[0];
  const issuePath = firstIssue?.path.join(".") || "payload";
  throw new BadWebhookRequestError(
    `invalid gitlab ${eventKind} payload: ${issuePath} ${firstIssue?.message ?? "schema validation failed"}`,
  );
}
