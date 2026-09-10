import type { CurrentServiceState, DeploymentService, Environment, Release } from "@heimdall/shared";
import {
  branchFromImageTags,
  classifyReleaseTag,
  environmentPointerTags,
  environments
} from "@heimdall/shared";
import type { EcsAdapter, RegistryAdapter, StabilityProgress } from "./types";

function environmentConfig(service: DeploymentService, environment: Environment) {
  const config = service.environments[environment];
  if (!config) {
    throw new Error(`Service ${service.serviceId} is not configured for ${environment}`);
  }
  return config;
}

const now = new Date().toISOString();

/** Derives `sourceBranch` from the release's own tag (mirroring how the real AWS adapter derives
 * it from all of a digest's ECR tags), so mock fixtures don't have to hand-maintain a value that
 * duplicates what's already encoded in `tag`. */
function withSourceBranch(release: Omit<Release, "sourceBranch">): Release {
  return { ...release, sourceBranch: branchFromImageTags([release.tag]) };
}

const manualReleases: Release[] = [
  // Non-release-eligible: a feature branch build. Exercises the gate's rejection path for
  // preprod/prod while remaining deployable to dev/stage.
  withSourceBranch({
    tag: "branch-feature-login-a1b2c3d",
    digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    pushedAt: now,
    source: "manual",
    isEnvironmentPointer: false
  }),
  // Release-eligible: a `main` branch build, tagged with the double-dash form CI actually
  // produces (`branch-<branch>--<shortsha>`). Exercises the gate's success path for preprod/prod.
  withSourceBranch({
    tag: "branch-main--fa867dc",
    digest: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
    pushedAt: now,
    source: "manual",
    isEnvironmentPointer: false
  }),
  withSourceBranch({
    tag: "dev-20260603-42-a1b2c3d",
    digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    pushedAt: now,
    source: "dev",
    isEnvironmentPointer: false
  }),
  withSourceBranch({
    tag: "stage-20260603-18-d4e5f6a",
    digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    pushedAt: now,
    source: "stage",
    isEnvironmentPointer: false
  }),
  withSourceBranch({
    tag: "hotfix-20260603-7-ab12cd3",
    digest: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
    pushedAt: now,
    source: "hotfix",
    isEnvironmentPointer: false
  })
];

const devPointerDigest = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const stagePointerDigest = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
const preprodPointerDigest = "sha256:3333333333333333333333333333333333333333333333333333333333333335";
const prodPointerDigest = "sha256:3333333333333333333333333333333333333333333333333333333333333333";

/**
 * Seed digests for each *logical* environment. The mock stays usable with both the sandbox
 * catalog (tags dev/stage/prod) and the SkillBrew catalog (tags dev/stg/staging/preprod/prod)
 * because pointer tags are always resolved from the service passed in, not from a hardcoded tag
 * set. preprod runs on the stage ECS cluster/service but is tracked by its own `preprod` pointer
 * tag, so it gets its own seed digest here.
 */
const seedDigestByEnvironment: Record<Environment, string> = {
  dev: devPointerDigest,
  stage: stagePointerDigest,
  preprod: preprodPointerDigest,
  prod: prodPointerDigest
};

/** Per-service, per-tag current digest. Keyed by `${serviceId}#${environmentTag}`. */
const envDigests = new Map<string, string>();

/**
 * Clears all mock promotion state. `envDigests` is module scope (shared across every
 * `MockRegistryAdapter` instance in the process), so without an explicit reset a fresh adapter
 * created later in the same test file still inherits digests written by earlier tests. Call this
 * in a `beforeEach` wherever tests rely on `MockRegistryAdapter`/`MockEcsAdapter` starting from
 * the seed digests.
 */
export function resetMockRegistry(): void {
  envDigests.clear();
}

function digestKey(service: DeploymentService, environmentTag: string): string {
  return `${service.serviceId}#${environmentTag}`;
}

function seedDigest(service: DeploymentService, environment: Environment): string | undefined {
  const config = service.environments[environment];
  if (!config) {
    return undefined;
  }
  const key = digestKey(service, config.environmentTag);
  if (!envDigests.has(key)) {
    envDigests.set(key, seedDigestByEnvironment[environment]);
  }
  return envDigests.get(key);
}

function pointerReleases(service: DeploymentService): Release[] {
  const releases: Release[] = [];
  for (const environment of environments) {
    const config = service.environments[environment];
    if (!config) {
      continue;
    }
    const digest = seedDigest(service, environment);
    if (!digest) {
      continue;
    }
    releases.push({
      tag: config.environmentTag,
      digest,
      pushedAt: now,
      source: classifyReleaseTag(config.environmentTag),
      isEnvironmentPointer: true
    });
  }
  return releases;
}

export class MockRegistryAdapter implements RegistryAdapter {
  public async listReleases(service: DeploymentService): Promise<Release[]> {
    const pointerTags = environmentPointerTags(service);
    const releases = [...manualReleases, ...pointerReleases(service)];
    return releases
      .map((release) => ({
        ...release,
        source: classifyReleaseTag(release.tag),
        isEnvironmentPointer: pointerTags.has(release.tag)
      }))
      .sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
  }

  public async findRelease(
    service: DeploymentService,
    tag: string,
    digest: string
  ): Promise<Release | undefined> {
    const releases = await this.listReleases(service);
    return releases.find((release) => release.tag === tag && release.digest === digest);
  }

  public async getEnvironmentDigest(
    service: DeploymentService,
    environment: Environment
  ): Promise<string | undefined> {
    return seedDigest(service, environment);
  }

  public async promoteEnvironmentTag(
    service: DeploymentService,
    environment: Environment,
    imageDigest: string
  ): Promise<void> {
    const config = environmentConfig(service, environment);
    envDigests.set(digestKey(service, config.environmentTag), imageDigest);
  }
}

export class MockEcsAdapter implements EcsAdapter {
  public async getCurrentState(
    service: DeploymentService,
    environment: Environment
  ): Promise<CurrentServiceState> {
    const config = environmentConfig(service, environment);
    return {
      serviceId: service.serviceId,
      environment,
      clusterName: config.clusterName,
      serviceName: config.serviceName,
      currentTaskDefinitionArn: `arn:aws:ecs:mock:task-definition/${config.taskFamily}:1`,
      environmentImageDigest: seedDigest(service, environment),
      runningCount: 1,
      desiredCount: 1,
      status: "ACTIVE"
    };
  }

  public async forceDeploy(
    service: DeploymentService,
    environment: Environment
  ): Promise<string | undefined> {
    return `arn:aws:ecs:mock:task-definition/${environmentConfig(service, environment).taskFamily}:1`;
  }

  public async rollbackToTaskDefinition(
    _service: DeploymentService,
    _environment: Environment,
    taskDefinitionArn: string
  ): Promise<string | undefined> {
    return taskDefinitionArn;
  }

  public async waitForStable(
    _service: DeploymentService,
    _environment: Environment,
    onProgress?: (progress: StabilityProgress) => void | Promise<void>
  ): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await onProgress?.({
      rolloutState: "COMPLETED",
      runningCount: 1,
      desiredCount: 1,
      pendingCount: 0,
      message: "stable (mock)"
    });
  }
}
