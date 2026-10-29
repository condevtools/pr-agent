import type { PullRequestReviewInput } from "#review";
import type { DiffFileContext } from "../../../repository/contracts.js";

export interface GitLabChange {
  new_path: string;
  old_path: string;
  diff: string;
  deleted_file?: boolean;
  new_file?: boolean;
  renamed_file?: boolean;
}

export interface GitLabChangesResponse {
  overflow?: boolean;
  changes: GitLabChange[];
  diff_refs: {
    base_sha: string;
    head_sha: string;
    start_sha: string;
  };
}

export interface GitLabCompareResponse {
  diffs?: GitLabChange[];
}

export interface GitLabCommentTarget {
  baseUrl: string;
  projectId: number;
  mrId: number;
}

export interface GitLabCollectedContext extends GitLabCommentTarget {
  coverage?: { status: "complete" | "partial"; reasonCodes: readonly string[] };
  input: PullRequestReviewInput;
  files: DiffFileContext[];
  webUrl: string;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  repository: string;
  diffRefs: {
    baseSha: string;
    headSha: string;
    startSha: string;
  };
  mrUrl: string;
}
