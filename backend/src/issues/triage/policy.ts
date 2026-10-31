import { decodeGitHubFileContent } from "../../integrations/github/repository/content.js";
import type { GitHubReviewContext } from "../../review/platforms/github/contracts.js";
import { parseRepositoryPolicyOverridesFromConfigText } from "../../review/policy/parser.js";
import { CONFIG_PATH_CANDIDATES } from "../policy/github/config.js";

/** Unlike the legacy best-effort loader, a provider/config error must not enable paid triage. */
export async function loadIssueTriagePolicy(context: GitHubReviewContext): Promise<{
  enabled: boolean; autoLabels: boolean;
}> {
  for (const path of CONFIG_PATH_CANDIDATES) {
    let response;
    try { response = await context.octokit.repos.getContent({ ...context.repo(), path }); }
    catch (error) {
      if (error && typeof error === "object" && "status" in error && error.status === 404) continue;
      throw error;
    }
    const file = response.data;
    if (Array.isArray(file) || file.type === "dir" || typeof file.content !== "string") {
      throw new Error("Issue triage policy must be a readable repository file");
    }
    const raw = decodeGitHubFileContent(file.content, file.encoding);
    if (Buffer.byteLength(raw) > 100_000) throw new Error("Issue triage policy exceeds the size limit");
    const config = parseRepositoryPolicyOverridesFromConfigText(raw).issue;
    return { enabled: config?.enabled !== false && config?.triageEnabled !== false,
      autoLabels: config?.autoLabelEnabled !== false };
  }
  return { enabled: true, autoLabels: true };
}
