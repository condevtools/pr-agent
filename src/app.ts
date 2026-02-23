import type { ApplicationFunction } from "probot";
import { assertRuntimeStateBackendReady } from "#core";
import {
  handleGitHubWebhookEvent,
} from "#integrations/github";

const ISSUE_POLICY_EVENTS = ["issues.opened", "issues.edited"] as const;
const PULL_REQUEST_EVENTS = [
  "pull_request.opened",
  "pull_request.edited",
  "pull_request.synchronize",
  "pull_request.closed",
] as const;
const PULL_REQUEST_REVIEW_THREAD_EVENTS = [
  "pull_request_review_thread.resolved",
  "pull_request_review_thread.unresolved",
] as const;

export const app: ApplicationFunction = (probot): void => {
  assertRuntimeStateBackendReady();
  probot.log.info("AI reviewer app loaded (GitHub + GitLab compatible)");

  const dispatchEvent = async (params: {
    eventName: "issues" | "pull_request" | "pull_request_review_thread" | "issue_comment";
    context: {
      payload: unknown;
      octokit: unknown;
      log: unknown;
    };
  }): Promise<void> => {
    await handleGitHubWebhookEvent({
      eventName: params.eventName,
      payload: params.context.payload,
      octokit: params.context.octokit as never,
      logger: params.context.log as never,
      runtimeMode: "github-app",
    });
  };

  for (const issueEvent of ISSUE_POLICY_EVENTS) {
    probot.on(issueEvent, async (context) => {
      await dispatchEvent({
        eventName: "issues",
        context,
      });
    });
  }

  for (const pullRequestEvent of PULL_REQUEST_EVENTS) {
    probot.on(pullRequestEvent, async (context) => {
      await dispatchEvent({
        eventName: "pull_request",
        context,
      });
    });
  }

  for (const threadEvent of PULL_REQUEST_REVIEW_THREAD_EVENTS) {
    probot.on(threadEvent, async (context) => {
      await dispatchEvent({
        eventName: "pull_request_review_thread",
        context,
      });
    });
  }

  probot.on("issue_comment.created", async (context) => {
    await dispatchEvent({
      eventName: "issue_comment",
      context,
    });
  });
};
