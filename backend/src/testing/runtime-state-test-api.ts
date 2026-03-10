import {
  clearRuntimeStateScope,
  clearRuntimeStateStore,
  flushRuntimeStatePersistence,
} from "../core/runtime-state.js";

const DEDUPE_STATE_SCOPE = "dedupe-requests";
const RATE_LIMIT_STATE_SCOPE = "rate-limit-records";
const ASK_SESSION_STATE_SCOPE = "ask-conversation-turns";
const GITHUB_FEEDBACK_SIGNAL_SCOPE = "github-feedback-signals";

export function clearDuplicateRequestState(): void {
  clearRuntimeStateScope(DEDUPE_STATE_SCOPE);
}

export function clearRateLimitState(): void {
  clearRuntimeStateScope(RATE_LIMIT_STATE_SCOPE);
}

export function clearAskConversationState(): void {
  clearRuntimeStateScope(ASK_SESSION_STATE_SCOPE);
}

export function clearGitHubFeedbackSignals(): void {
  clearRuntimeStateScope(GITHUB_FEEDBACK_SIGNAL_SCOPE);
}

export { clearRuntimeStateStore, flushRuntimeStatePersistence };
