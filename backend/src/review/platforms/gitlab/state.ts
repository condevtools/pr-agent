import { readNumberEnv } from "#core";
import { recordFeedbackSignal } from "../../state/feedback-signals.js";
import { loadIncrementalReviewHead, readMergedFeedbackSignals, rememberIncrementalReviewHead } from "../../state/review-state.js";

export function recordGitLabFeedbackSignal(params: {
  projectId: number;
  signal: string;
}): void {
  const key = `${params.projectId}`;
  recordFeedbackSignal({
    scope: GITLAB_FEEDBACK_SIGNAL_SCOPE,
    key,
    signal: params.signal,
    ttlMs: readNumberEnv(
      "GITLAB_FEEDBACK_SIGNAL_TTL_MS",
      DEFAULT_FEEDBACK_SIGNAL_TTL_MS,
    ),
    maxSignals: MAX_FEEDBACK_SIGNALS,
    maxEntries: MAX_FEEDBACK_CACHE_ENTRIES,
  });
}


export function getIncrementalHead(reviewMrKey: string): string | undefined {
  return loadIncrementalReviewHead({
    scope: GITLAB_INCREMENTAL_STATE_SCOPE,
    key: reviewMrKey,
  });
}

export function rememberIncrementalHead(reviewMrKey: string, headSha: string): void {
  rememberIncrementalReviewHead({
    scope: GITLAB_INCREMENTAL_STATE_SCOPE,
    key: reviewMrKey,
    headSha,
    ttlMs: readNumberEnv(
      "GITLAB_INCREMENTAL_STATE_TTL_MS",
      DEFAULT_INCREMENTAL_STATE_TTL_MS,
    ),
    maxEntries: MAX_INCREMENTAL_STATE_ENTRIES,
  });
}

export function loadGitLabFeedbackSignals(projectId: number): string[] {
  const key = `${projectId}`;
  return readMergedFeedbackSignals({
    scope: GITLAB_FEEDBACK_SIGNAL_SCOPE,
    scopedKey: key,
    maxSignals: MAX_FEEDBACK_SIGNALS,
  });
}


const DEFAULT_INCREMENTAL_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_FEEDBACK_SIGNAL_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_INCREMENTAL_STATE_ENTRIES = 2_000;
const MAX_FEEDBACK_SIGNALS = 80;
const MAX_FEEDBACK_CACHE_ENTRIES = 1_000;
const GITLAB_INCREMENTAL_STATE_SCOPE = "gitlab-incremental-head";
const GITLAB_FEEDBACK_SIGNAL_SCOPE = "gitlab-feedback-signals";
