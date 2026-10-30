import {
  parseAddDocCommand,
  parseImproveCommand,
  parseImproveComponentCommand,
  parseReviewCommand,
} from "./parsers/index.js";

export type DurableCommand = "review" | "improve" | "add_doc" | "improve_component";

export class CommandAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandAuthorizationError";
  }
}

export function classifyDurableCommand(
  platform: "github" | "gitlab",
  body: string,
): DurableCommand | undefined {
  if (parseReviewCommand(body).matched) return "review";
  if (platform === "gitlab") return undefined;
  if (parseImproveCommand(body).matched) return "improve";
  if (parseAddDocCommand(body).matched) return "add_doc";
  if (parseImproveComponentCommand(body).matched) return "improve_component";
  return undefined;
}

export async function authorizeGitHubDurableCommand(input: {
  owner: string;
  repo: string;
  login?: string;
  userId?: number;
  getPermission(): Promise<string | undefined>;
}): Promise<void> {
  if (!input.login?.trim() || !Number.isSafeInteger(input.userId) || (input.userId ?? 0) <= 0) {
    throw new CommandAuthorizationError("GitHub command actor identity is required");
  }
  const permission = (await input.getPermission())?.trim().toLowerCase();
  if (permission !== "write" && permission !== "maintain" && permission !== "admin") {
    throw new CommandAuthorizationError("GitHub durable commands require repository write permission");
  }
}

export async function authorizeGitLabDurableCommand(input: {
  projectId: number;
  userId?: number;
  getAccessLevel(): Promise<number | undefined>;
}): Promise<void> {
  if (!Number.isSafeInteger(input.userId) || (input.userId ?? 0) <= 0) {
    throw new CommandAuthorizationError("GitLab command actor identity is required");
  }
  const accessLevel = await input.getAccessLevel();
  if (!Number.isSafeInteger(accessLevel) || (accessLevel ?? 0) < 30) {
    throw new CommandAuthorizationError("GitLab durable review requires Developer access");
  }
}
