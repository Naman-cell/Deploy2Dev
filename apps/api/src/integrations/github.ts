import type { DeploymentService, OpenPullRequest, Release } from "@heimdall/shared";
import { sanitizeBranchName } from "@heimdall/shared";
import type { Logger } from "../logger";
import type { RegistryAdapter } from "./types";

export interface GitHubAdapter {
  listOpenPullRequests(
    service: DeploymentService
  ): Promise<Omit<OpenPullRequest, "imageTag" | "release">[]>;
}

const GITHUB_API_BASE = "https://api.github.com";

interface GitHubPullRequestResponse {
  number: number;
  title: string;
  updated_at: string;
  head: { ref: string; sha: string };
  base: { ref: string };
}

export class RealGitHubAdapter implements GitHubAdapter {
  public constructor(private readonly token?: string) {}

  public async listOpenPullRequests(
    service: DeploymentService
  ): Promise<Omit<OpenPullRequest, "imageTag" | "release">[]> {
    if (!service.githubRepository || service.githubRepository.includes("TODO-")) {
      return [];
    }

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (this.token) {
      headers.Authorization = `token ${this.token}`;
    }

    const response = await fetch(
      `${GITHUB_API_BASE}/repos/${service.githubRepository}/pulls?state=open&per_page=100`,
      { headers, signal: AbortSignal.timeout(10000) }
    );

    if (!response.ok) {
      throw new Error(
        `GitHub API error listing open pull requests for ${service.githubRepository}: ${response.status} ${response.statusText}`
      );
    }

    const body = (await response.json()) as GitHubPullRequestResponse[];
    return body.map((pr) => ({
      number: pr.number,
      title: pr.title,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      headSha: pr.head.sha,
      updatedAt: pr.updated_at
    }));
  }
}

export class MockGitHubAdapter implements GitHubAdapter {
  public async listOpenPullRequests(
    _service: DeploymentService
  ): Promise<Omit<OpenPullRequest, "imageTag" | "release">[]> {
    const now = new Date().toISOString();
    return [
      {
        number: 101,
        title: "Add badge verification endpoint",
        headBranch: "feature/PROJ-123-badge-cert",
        baseBranch: "dev",
        headSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        updatedAt: now
      },
      {
        number: 102,
        title: "Fix login redirect loop",
        headBranch: "feature-login",
        baseBranch: "staging",
        headSha: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
        updatedAt: now
      },
      {
        number: 103,
        title: "Bump dependencies",
        headBranch: "chore/deps-bump",
        baseBranch: "preprod",
        headSha: "c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
        updatedAt: now
      },
      {
        number: 104,
        title: "Hotfix production issue",
        headBranch: "hotfix/critical",
        baseBranch: "main",
        headSha: "d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5",
        updatedAt: now
      }
    ];
  }
}

/** Drives the "deploy an open PR image to dev" flow: resolves each PR's ECR release by matching
 * the sanitized branch name against ECR image tags. Under the branch-name tagging convention CI
 * pushes a single tag equal to the sanitized branch name (e.g. `feature/login` → `feature-login-`,
 * trailing dash included — see `sanitizeBranchName`), so the image tag IS the branch name and a
 * direct tag lookup suffices. */
export async function enrichOpenPullRequests(
  service: DeploymentService,
  prs: Omit<OpenPullRequest, "imageTag" | "release">[],
  registry: RegistryAdapter,
  logger?: Logger
): Promise<OpenPullRequest[]> {
  let releases: Release[] = [];
  try {
    releases = await registry.listReleases(service);
  } catch (error) {
    logger?.warn("enrichOpenPullRequests: listReleases failed, returning PRs unenriched", {
      serviceId: service.serviceId,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  // Environment-pointer releases (e.g. `:dev`) are excluded here: a PR whose branch happens to be
  // named `dev`/`stage`/`prod` would otherwise match the live pointer image and the UI would
  // silently offer to "deploy" it — which would actually just re-promote the current pointer
  // image instead of the PR's real code.
  const byTag = new Map<string, Release>();
  for (const release of releases) {
    if (release.isEnvironmentPointer) {
      continue;
    }
    if (!byTag.has(release.tag)) {
      byTag.set(release.tag, release);
    }
  }

  return prs.map((pr) => {
    const imageTag = sanitizeBranchName(pr.headBranch);
    const release = byTag.get(imageTag);
    return { ...pr, imageTag, release };
  });
}
