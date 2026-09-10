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

/** Per-poll snapshot of ECS rollout progress, surfaced to callers of `EcsAdapter.waitForStable` so
 * they can stream live status (e.g. as deployment events) instead of blocking on a single opaque
 * promise. */
export interface StabilityProgress {
  /** PRIMARY deployment rolloutState (IN_PROGRESS/COMPLETED/FAILED), when ECS reports one. */
  rolloutState?: string;
  runningCount: number;
  desiredCount: number;
  pendingCount: number;
  /** Latest ECS service event message, when available. */
  lastServiceEvent?: string;
  /** Human summary, e.g. "0/1 running, 1 pending — IN_PROGRESS". */
  message: string;
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
  waitForStable(
    service: DeploymentService,
    environment: Environment,
    onProgress?: (progress: StabilityProgress) => void | Promise<void>
  ): Promise<void>;
}

export interface CloudAdapters {
  registry: RegistryAdapter;
  ecs: EcsAdapter;
}
