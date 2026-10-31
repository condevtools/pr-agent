import { createHash } from "node:crypto";
import { z } from "zod";

import { canonicalJson } from "../../../agent-runtime/versions.js";

const safePositiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const githubIssueSubjectSchema = z.object({
  id: safePositiveInteger,
  number: safePositiveInteger,
  title: z.string().max(1_024),
  body: z.string().max(65_536).nullable(),
  state: z.enum(["open", "closed"]),
  pull_request: z.never().optional(),
});

const githubIssueIdentitySchema = githubIssueSubjectSchema.extend({
  user: z.object({
    id: safePositiveInteger,
    login: z.string().min(1).max(512),
    type: z.string().max(64).optional(),
  }),
});

export interface GitHubIssueSubject {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
}

export interface GitHubIssueIdentity extends GitHubIssueSubject {
  user: { id: number; login: string; type?: string };
}

export function parseGitHubIssueSubject(value: unknown): GitHubIssueSubject {
  return githubIssueSubjectSchema.parse(value);
}

export function parseGitHubIssue(value: unknown): GitHubIssueIdentity {
  return githubIssueIdentitySchema.parse(value);
}

export function githubIssueRevision(issue: GitHubIssueSubject): string {
  return createHash("sha256").update(canonicalJson({
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
  })).digest("hex");
}
