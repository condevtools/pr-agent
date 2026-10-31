import type { ApplicationFunction } from "probot";
import { requireOnlinePublicationAuthority } from "../agent-runtime/publication/mode.js";
import {
  handleGitHubWebhookEvent,
} from "#integrations/github";
import { runVerifiedGitHubIntake } from "../http/webhooks/github/verified-github-intake.js";

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
const INSTALLATION_EVENTS = ["installation.created", "installation.deleted", "installation.suspend",
  "installation.unsuspend", "installation.new_permissions_accepted"] as const;
const INSTALLATION_REPOSITORY_EVENTS = ["installation_repositories.added", "installation_repositories.removed"] as const;

export const app: ApplicationFunction = (probot): void => {
  requireOnlinePublicationAuthority();
  probot.log.info("AI reviewer app loaded (GitHub + GitLab compatible)");

  const dispatchEvent = async (params: {
    eventName: "issues" | "pull_request" | "pull_request_review_thread" | "issue_comment"
      | "installation" | "installation_repositories";
    context: {
      payload: unknown;
      octokit: unknown;
      log: unknown;
      id?: string;
    };
  }): Promise<void> => {
    await runVerifiedGitHubIntake({
      eventName: params.eventName,
      deliveryId: params.context.id,
      payload: params.context.payload,
      execute: ({ sourceHash }) => handleGitHubWebhookEvent({
        eventName: params.eventName,
        payload: params.context.payload,
        octokit: params.context.octokit as never,
        logger: params.context.log as never,
        runtimeMode: "github-app",
        deliveryId: params.context.id,
        sourceHash,
      }),
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

  for (const installationEvent of INSTALLATION_EVENTS) {
    probot.on(installationEvent, async (context) => {
      await dispatchEvent({ eventName: "installation", context });
    });
  }

  for (const repositoryEvent of INSTALLATION_REPOSITORY_EVENTS) {
    probot.on(repositoryEvent, async (context) => {
      await dispatchEvent({ eventName: "installation_repositories", context });
    });
  }
};
