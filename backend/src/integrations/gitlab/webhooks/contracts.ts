import { BadWebhookRequestError } from "#core";
import { z } from "zod";

export interface LoggerLike {
  info(metadata: unknown, message: string): void;
  error(metadata: unknown, message: string): void;
}

export interface GitLabMrWebhookBody {
  object_kind?: string;
  event_type?: string;
  user?: {
    id?: number;
    username?: string;
  };
  project: {
    id: number;
    name: string;
    web_url: string;
    path_with_namespace?: string;
  };
  object_attributes: {
    action?: string;
    state?: string;
    iid: number;
    url: string;
    title: string;
    description?: string;
    work_in_progress?: boolean;
    draft?: boolean;
    source_branch: string;
    target_branch: string;
    last_commit?: {
      id?: string;
    };
  };
  merge_request?: {
    iid?: number;
    title?: string;
    description?: string;
    work_in_progress?: boolean;
    draft?: boolean;
    source_branch?: string;
    target_branch?: string;
    url?: string;
    state?: string;
  };
}

export interface GitLabNoteWebhookBody {
  object_kind?: string;
  event_type?: string;
  user?: {
    id?: number;
    username?: string;
  };
  project: {
    id: number;
    name: string;
    web_url: string;
    path_with_namespace?: string;
  };
  object_attributes: {
    action?: string;
    note?: string;
    noteable_type?: string;
    noteable_iid?: number | string;
    url?: string;
  };
  merge_request?: {
    iid?: number;
    title?: string;
    description?: string;
    source_branch?: string;
    target_branch?: string;
    url?: string;
    state?: string;
  };
}

export type GitLabWebhookBody = GitLabMrWebhookBody | GitLabNoteWebhookBody;

// ---------------------------------------------------------------------------
// Zod payload schemas for GitLab webhooks
// ---------------------------------------------------------------------------

const gitlabProjectSchema = z.object({
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
      id: z.number().int().positive().optional(),
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
      id: z.number().int().positive().optional(),
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
