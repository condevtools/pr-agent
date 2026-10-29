import { readNumberEnv } from "#core";
import { recordFeedbackSignal } from "../../state/feedback-signals.js";
import {
  loadIncrementalReviewHead,
  readMergedFeedbackSignals,
  rememberIncrementalReviewHead,
} from "../../state/review-state.js";

const DEFAULT_INCREMENTAL_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_INCREMENTAL_STATE_ENTRIES = 2_000;
const DEFAULT_FEEDBACK_SIGNAL_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_FEEDBACK_SIGNALS = 80;
const MAX_FEEDBACK_CACHE_ENTRIES = 1_000;
const GITHUB_INCREMENTAL_STATE_SCOPE = "github-incremental-head";
const GITHUB_FEEDBACK_SIGNAL_SCOPE = "github-feedback-signals";

export function recordGitHubFeedbackSignal(params: {
  owner: string;
  repo: string;
  pullNumber?: number;
  signal: string;
}): void {
  const feedbackKey = buildGitHubFeedbackSignalKey(
    params.owner,
    params.repo,
    params.pullNumber,
  );
  recordFeedbackSignal({
    scope: GITHUB_FEEDBACK_SIGNAL_SCOPE,
    key: feedbackKey,
    signal: params.signal,
    ttlMs: readNumberEnv(
      "GITHUB_FEEDBACK_SIGNAL_TTL_MS",
      DEFAULT_FEEDBACK_SIGNAL_TTL_MS,
    ),
    maxSignals: MAX_FEEDBACK_SIGNALS,
    maxEntries: MAX_FEEDBACK_CACHE_ENTRIES,
  });
}

export function loadGitHubFeedbackSignals(
  owner: string,
  repo: string,
  pullNumber?: number,
): string[] {
  const feedbackKey = buildGitHubFeedbackSignalKey(owner, repo, pullNumber);
  const repositoryLevelKey = buildGitHubFeedbackSignalKey(owner, repo);
  if (
    !Number.isInteger(pullNumber) ||
    (pullNumber as number) <= 0 ||
    feedbackKey === repositoryLevelKey
  ) {
    return readMergedFeedbackSignals({
      scope: GITHUB_FEEDBACK_SIGNAL_SCOPE,
      scopedKey: repositoryLevelKey,
      maxSignals: MAX_FEEDBACK_SIGNALS,
    });
  }
  return readMergedFeedbackSignals({
    scope: GITHUB_FEEDBACK_SIGNAL_SCOPE,
    scopedKey: feedbackKey,
    fallbackKey: repositoryLevelKey,
    maxSignals: MAX_FEEDBACK_SIGNALS,
  });
}

function buildGitHubFeedbackSignalKey(
  owner: string,
  repo: string,
  pullNumber?: number,
): string {
  const base = `${owner}/${repo}`;
  if (!Number.isInteger(pullNumber) || (pullNumber as number) <= 0) {
    return base;
  }

  return `${base}#${pullNumber}`;
}

export function readGitHubFeedbackSignals(
  owner: string,
  repo: string,
  pullNumber?: number,
): string[] {
  return loadGitHubFeedbackSignals(owner, repo, pullNumber);
}

export function getIncrementalHead(reviewPrKey: string): string | undefined {
  return loadIncrementalReviewHead({
    scope: GITHUB_INCREMENTAL_STATE_SCOPE,
    key: reviewPrKey,
  });
}

export function rememberIncrementalHead(reviewPrKey: string, headSha: string): void {
  rememberIncrementalReviewHead({
    scope: GITHUB_INCREMENTAL_STATE_SCOPE,
    key: reviewPrKey,
    headSha,
    ttlMs: readNumberEnv(
      "GITHUB_INCREMENTAL_STATE_TTL_MS",
      DEFAULT_INCREMENTAL_STATE_TTL_MS,
    ),
    maxEntries: MAX_INCREMENTAL_STATE_ENTRIES,
  });
}
