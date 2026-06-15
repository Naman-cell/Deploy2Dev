import type { CurrentServiceState, DeploymentService, Environment, Release } from "@heimdall/shared";
import { classifyReleaseTag } from "@heimdall/shared";
import type { EcsAdapter, RegistryAdapter } from "./types";

function environmentConfig(service: DeploymentService, environment: Environment) {
  const config = service.environments[environment];
  if (!config) {
    throw new Error(`Service ${service.serviceId} is not configured for ${environment}`);
  }
  return config;
}

const now = new Date().toISOString();

const releases: Release[] = [
  {
    tag: "branch-feature-login-a1b2c3d",
    digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    pushedAt: now,
    source: "manual",
    isEnvironmentPointer: false
  },
  {
    tag: "dev-20260603-42-a1b2c3d",
    digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    pushedAt: now,
    source: "dev",
    isEnvironmentPointer: false
  },
  {
    tag: "stage-20260603-18-d4e5f6a",
    digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    pushedAt: now,
    source: "stage",
    isEnvironmentPointer: false
  },
  {
    tag: "hotfix-20260603-7-ab12cd3",
    digest: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
    pushedAt: now,
    source: "hotfix",
    isEnvironmentPointer: false
  },
  {
    tag: "dev",
    digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    pushedAt: now,
    source: "dev",
    isEnvironmentPointer: true
  },
  {
    tag: "stage",
    digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    pushedAt: now,
    source: "stage",
    isEnvironmentPointer: true
  }
];

const envDigests = new Map<Environment, string>([
  ["dev", releases[4]?.digest ?? ""],
  ["stage", releases[5]?.digest ?? ""],
  ["prod", releases[5]?.digest ?? ""]
]);

export class MockRegistryAdapter implements RegistryAdapter {
  public async listReleases(_service: DeploymentService, _environment: Environment): Promise<Release[]> {
    return releases
      .map((release) => ({ ...release, source: classifyReleaseTag(release.tag) }))
      .sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
  }

  public async getEnvironmentDigest(
    _service: DeploymentService,
    environment: Environment
  ): Promise<string | undefined> {
    return envDigests.get(environment);
  }

  public async promoteEnvironmentTag(
    _service: DeploymentService,
    environment: Environment,
    imageDigest: string
  ): Promise<void> {
    envDigests.set(environment, imageDigest);
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
      environmentImageDigest: envDigests.get(environment),
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

  public async waitForStable(_service: DeploymentService, _environment: Environment): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
