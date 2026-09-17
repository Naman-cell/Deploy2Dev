import type { DeploymentService } from "@heimdall/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichOpenPullRequests, RealGitHubAdapter } from "./github";
import type { RegistryAdapter } from "./types";

function baseService(overrides: Partial<DeploymentService> = {}): DeploymentService {
  return {
    serviceId: "sample-service",
    name: "Sample Service",
    githubRepository: "Naman-cell/Deploy2Dev",
    ecrRepository: "deploy2dev/sample-service",
    containerName: "app",
    environments: {
      dev: {
        clusterName: "deploy2dev-dev",
        serviceName: "sample-service-dev",
        taskFamily: "deploy2dev-sample-service-dev",
        environmentTag: "dev"
      }
    },
    allowedDeployRolesByEnvironment: {
      dev: ["admin", "user"]
    },
    ...overrides
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RealGitHubAdapter.listOpenPullRequests", () => {
  it("returns [] without making a network call when githubRepository is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const service = baseService({ githubRepository: "" });
    const adapter = new RealGitHubAdapter();

    await expect(adapter.listOpenPullRequests(service)).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns [] without making a network call when githubRepository still has a TODO- placeholder", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const service = baseService({ githubRepository: "Brudite-Pvt-Ltd/TODO-django_app" });
    const adapter = new RealGitHubAdapter();

    await expect(adapter.listOpenPullRequests(service)).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a descriptive error on a non-OK response, without leaking the configured token", async () => {
    const secretToken = "ghp_super-secret-token-value";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found"
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = baseService();
    const adapter = new RealGitHubAdapter(secretToken);

    await expect(adapter.listOpenPullRequests(service)).rejects.toThrow(
      `GitHub API error listing open pull requests for ${service.githubRepository}: 404 Not Found`
    );
    await adapter.listOpenPullRequests(service).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secretToken);
    });
  });

  it("maps a well-formed GitHub API response to OpenPullRequest fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve([
          {
            number: 42,
            title: "Add badge verification endpoint",
            updated_at: "2026-01-01T00:00:00.000Z",
            head: { ref: "feature/PROJ-123-badge-cert", sha: "a1b2c3d" },
            base: { ref: "main" }
          }
        ])
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = baseService();
    const adapter = new RealGitHubAdapter();

    const prs = await adapter.listOpenPullRequests(service);

    expect(prs).toEqual([
      {
        number: 42,
        title: "Add badge verification endpoint",
        headBranch: "feature/PROJ-123-badge-cert",
        baseBranch: "main",
        headSha: "a1b2c3d",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ]);
  });

  it("sends an Authorization header only when a token is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([])
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = baseService();
    await new RealGitHubAdapter("a-token").listOpenPullRequests(service);
    const [, optionsWithToken] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((optionsWithToken.headers as Record<string, string>).Authorization).toBe("token a-token");

    fetchMock.mockClear();
    await new RealGitHubAdapter().listOpenPullRequests(service);
    const [, optionsWithoutToken] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((optionsWithoutToken.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe("enrichOpenPullRequests", () => {
  function makeRegistry(releases: Awaited<ReturnType<RegistryAdapter["listReleases"]>>): RegistryAdapter {
    return {
      listReleases: vi.fn().mockResolvedValue(releases),
      getEnvironmentDigest: vi.fn(),
      promoteEnvironmentTag: vi.fn(),
      findRelease: vi.fn()
    };
  }

  it("does not resolve a PR named after an environment pointer (e.g. `dev`) to the live pointer image", async () => {
    const service = baseService();
    // sanitizeBranchName("dev") === "dev-" (trailing dash CI always produces). Simulate a pointer
    // release that happens to carry that same tag to isolate the isEnvironmentPointer guard from
    // any coincidence of the real (non-dashed) pointer-tag convention.
    const registry = makeRegistry([
      {
        tag: "dev-",
        digest: "sha256:pointer",
        source: "dev",
        isEnvironmentPointer: true,
        sourceBranch: "dev-"
      }
    ]);

    const [enriched] = await enrichOpenPullRequests(
      service,
      [
        {
          number: 1,
          title: "PR from a branch literally named dev",
          headBranch: "dev",
          baseBranch: "main",
          headSha: "abc1234",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ],
      registry
    );

    expect(enriched?.imageTag).toBe("dev-");
    expect(enriched?.release).toBeUndefined();
  });
});
