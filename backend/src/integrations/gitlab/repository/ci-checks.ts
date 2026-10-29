import { gitLabApiRequest } from "../api/http-client.js";

export async function loadGitLabHeadChecks(params: {
  baseUrl: string;
  projectId: number;
  gitlabToken: string;
  headSha: string;
}): Promise<
  Array<{
    name: string;
    status: string;
    conclusion: string;
    detailsUrl?: string;
    summary?: string;
  }>
> {
  let response: Response;
  try {
    response = await gitLabApiRequest({
      url: `${params.baseUrl}/api/v4/projects/${encodeURIComponent(params.projectId)}/repository/commits/${encodeURIComponent(params.headSha)}/statuses?per_page=100`,
      token: params.gitlabToken,
    });
  } catch {
    return [];
  }

  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as Array<{
    name?: string;
    status?: string;
    target_url?: string | null;
    description?: string | null;
  }>;
  if (!Array.isArray(data)) {
    return [];
  }

  return data.slice(0, 50).map((item) => {
    const status = item.status?.trim() || "unknown";
    return {
      name: item.name?.trim() || "unknown-check",
      status,
      conclusion: mapGitLabStatusToConclusion(status),
      detailsUrl: item.target_url ?? undefined,
      summary: item.description ?? undefined,
    };
  });
}

export function mapGitLabStatusToConclusion(statusRaw: string | undefined): string {
  const status = statusRaw?.trim().toLowerCase() ?? "";
  if (status === "success") {
    return "success";
  }
  if (status === "failed" || status === "failure") {
    return "failure";
  }
  if (status === "canceled" || status === "cancelled") {
    return "cancelled";
  }
  if (status === "skipped") {
    return "skipped";
  }
  if (status === "manual") {
    return "action_required";
  }
  if (
    status === "running" ||
    status === "pending" ||
    status === "created" ||
    status === "waiting_for_resource" ||
    status === "preparing" ||
    status === "scheduled"
  ) {
    return "pending";
  }
  return "unknown";
}
