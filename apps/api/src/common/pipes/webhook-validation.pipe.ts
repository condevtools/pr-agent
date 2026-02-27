import { PipeTransform, Injectable, BadRequestException } from "@nestjs/common";

const GITHUB_ALLOWED_EVENTS = new Set([
  "issue_comment",
  "issues",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_review_thread",
  "installation",
  "installation_repositories",
  "ping",
]);

const GITLAB_ALLOWED_EVENTS = new Set([
  "merge request hook",
  "note hook",
  "push hook",
  "pipeline hook",
  "tag push hook",
  "ping",
]);

@Injectable()
export class GithubEventValidationPipe implements PipeTransform {
  transform(value: string | undefined): string {
    const event = (value ?? "").toLowerCase().trim();
    if (!event) {
      throw new BadRequestException("Missing x-github-event header");
    }
    if (!GITHUB_ALLOWED_EVENTS.has(event)) {
      throw new BadRequestException(`Unsupported GitHub event type: ${event}`);
    }
    return event;
  }
}

@Injectable()
export class GitlabEventValidationPipe implements PipeTransform {
  transform(value: string | undefined): string {
    const event = (value ?? "").toLowerCase().trim();
    if (!event) {
      throw new BadRequestException("Missing x-gitlab-event header");
    }
    if (!GITLAB_ALLOWED_EVENTS.has(event)) {
      throw new BadRequestException(`Unsupported GitLab event type: ${event}`);
    }
    return event;
  }
}
