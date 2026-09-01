import type { CurrentServiceState, DeploymentService, Environment, Release } from "@heimdall/shared";

export interface RegistryAdapter {
  listReleases(service: DeploymentService): Promise<Release[]>;
  getEnvironmentDigest(service: DeploymentService, environment: Environment): Promise<string | undefined>;
  promoteEnvironmentTag(
    service: DeploymentService,
    environment: Environment,
    imageDigest: string
  ): Promise<void>;
  findRelease(service: DeploymentService, tag: string, digest: string): Promise<Release | undefined>;
}

export interface EcsAdapter {
  getCurrentState(
    service: DeploymentService,
    environment: Environment
  ): Promise<CurrentServiceState>;
  forceDeploy(service: DeploymentService, environment: Environment): Promise<string | undefined>;
  rollbackToTaskDefinition(
    service: DeploymentService,
    environment: Environment,
    taskDefinitionArn: string
  ): Promise<string | undefined>;
  waitForStable(service: DeploymentService, environment: Environment): Promise<void>;
}

export interface CloudAdapters {
  registry: RegistryAdapter;
  ecs: EcsAdapter;
}
