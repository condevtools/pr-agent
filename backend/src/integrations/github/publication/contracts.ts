import type { PublicationService, PublicationScope } from "../../../agent-runtime/publication/publication.js";
import type { PublicationAdapterFactory, PublicationBatchCoordinator, PublicationBatchStore } from "../../../agent-runtime/publication/batches.js";
import type { PublicationBinding } from "../../../agent-runtime/authority/publication-authority.js";
import type { MinimalGitHubOctokit } from "../api/types.js";

export interface GitHubPublicationContext { octokit: MinimalGitHubOctokit }

export type GitHubPublicationBinding = Omit<PublicationBinding, "platform"> & { platform: "github" };

export interface GitHubCredentialIdentity {
  actorId: number;
  kind: "user-token" | "github-app-installation";
  login?: string;
  installationId?: number;
  appId?: number;
}

export type GitHubCredentialIdentityVerifier = () => Promise<GitHubCredentialIdentity>;

export interface GitHubPublicationRuntime {
  service: PublicationService;
  scope: Omit<PublicationScope, "target" | "revision">;
  binding?: GitHubPublicationBinding;
  batchStore?: PublicationBatchStore;
  batchCoordinator?: PublicationBatchCoordinator;
  createAdapter?: PublicationAdapterFactory;
  resolveCredential?: () => Promise<string>;
  verifyCredentialIdentity?: GitHubCredentialIdentityVerifier;
  planOperation?: (operation: { slot: string; payload: Record<string, unknown> }) => void;
}
