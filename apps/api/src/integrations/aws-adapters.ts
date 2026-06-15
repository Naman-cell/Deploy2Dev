import {
  BatchGetImageCommand,
  DescribeImagesCommand,
  ECRClient,
  PutImageCommand
} from "@aws-sdk/client-ecr";
import {
  DescribeTaskDefinitionCommand,
  DescribeServicesCommand,
  ECSClient,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
  waitUntilServicesStable
} from "@aws-sdk/client-ecs";
import type { CurrentServiceState, DeploymentService, Environment, Release } from "@heimdall/shared";
import { classifyReleaseTag } from "@heimdall/shared";
import type { AppConfig } from "../config";
import { AppError } from "../errors";
import type { EcsAdapter, RegistryAdapter } from "./types";

function repositoryName(service: DeploymentService): string {
  return service.ecrRepository;
}

function environmentConfig(service: DeploymentService, environment: Environment) {
  const config = service.environments[environment];
  if (!config) {
    throw new AppError(400, "environment_not_configured", "Service is not configured for this environment");
  }
  return config;
}

function isEcrImageNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "ImageNotFoundException"
  );
}

export class AwsRegistryAdapter implements RegistryAdapter {
  private readonly client: ECRClient;

  public constructor(config: AppConfig) {
    this.client = new ECRClient({ region: config.awsRegion });
  }

  public async listReleases(service: DeploymentService): Promise<Release[]> {
    const result = await this.client.send(
      new DescribeImagesCommand({
        repositoryName: repositoryName(service),
        filter: { tagStatus: "TAGGED" }
      })
    );

    return (result.imageDetails ?? [])
      .flatMap((detail) => {
        const digest = detail.imageDigest;
        if (!digest) {
          return [];
        }
        return (detail.imageTags ?? []).map<Release>((tag) => ({
          tag,
          digest,
          pushedAt: detail.imagePushedAt?.toISOString(),
          source: classifyReleaseTag(tag),
          isEnvironmentPointer: tag === "dev" || tag === "stage" || tag === "prod"
        }));
      })
      .sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
  }

  public async getEnvironmentDigest(
    service: DeploymentService,
    environment: Environment
  ): Promise<string | undefined> {
    try {
      const result = await this.client.send(
        new DescribeImagesCommand({
          repositoryName: repositoryName(service),
          imageIds: [{ imageTag: environment }]
        })
      );
      return result.imageDetails?.[0]?.imageDigest;
    } catch (error) {
      if (isEcrImageNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  public async promoteEnvironmentTag(
    service: DeploymentService,
    environment: Environment,
    imageDigest: string
  ): Promise<void> {
    const batch = await this.client.send(
      new BatchGetImageCommand({
        repositoryName: repositoryName(service),
        imageIds: [{ imageDigest }],
        acceptedMediaTypes: [
          "application/vnd.docker.distribution.manifest.v2+json",
          "application/vnd.oci.image.manifest.v1+json"
        ]
      })
    );

    const image = batch.images?.[0];
    if (!image?.imageManifest) {
      throw new AppError(404, "image_manifest_not_found", "Selected image manifest was not found");
    }

    await this.client.send(
      new PutImageCommand({
        repositoryName: repositoryName(service),
        imageManifest: image.imageManifest,
        imageTag: environment
      })
    );
  }
}

export class AwsEcsAdapter implements EcsAdapter {
  private readonly client: ECSClient;

  public constructor(config: AppConfig) {
    this.client = new ECSClient({ region: config.awsRegion });
  }

  public async getCurrentState(
    service: DeploymentService,
    environment: Environment
  ): Promise<CurrentServiceState> {
    const env = environmentConfig(service, environment);
    const result = await this.client.send(
      new DescribeServicesCommand({
        cluster: env.clusterName,
        services: [env.serviceName]
      })
    );
    const ecsService = result.services?.[0];
    if (!ecsService) {
      throw new AppError(404, "ecs_service_not_found", "ECS service was not found");
    }

    return {
      serviceId: service.serviceId,
      environment,
      clusterName: env.clusterName,
      serviceName: env.serviceName,
      currentTaskDefinitionArn: ecsService.taskDefinition,
      runningCount: ecsService.runningCount,
      desiredCount: ecsService.desiredCount,
      status: ecsService.status
    };
  }

  public async forceDeploy(
    service: DeploymentService,
    environment: Environment
  ): Promise<string | undefined> {
    const env = environmentConfig(service, environment);
    const current = await this.getCurrentState(service, environment);
    if (!current.currentTaskDefinitionArn) {
      throw new AppError(404, "task_definition_not_found", "Current task definition was not found");
    }

    const currentDefinition = await this.client.send(
      new DescribeTaskDefinitionCommand({
        taskDefinition: current.currentTaskDefinitionArn
      })
    );
    const taskDefinition = currentDefinition.taskDefinition;
    if (!taskDefinition?.containerDefinitions) {
      throw new AppError(404, "task_definition_not_found", "Task definition details were not found");
    }

    const nextImage = `${service.ecrRepositoryUri ?? service.ecrRepository}:${environment}`;
    const nextContainerDefinitions = taskDefinition.containerDefinitions.map((container) =>
      container.name === service.containerName ? { ...container, image: nextImage } : container
    );

    const registered = await this.client.send(
      new RegisterTaskDefinitionCommand({
        family: env.taskFamily,
        taskRoleArn: taskDefinition.taskRoleArn,
        executionRoleArn: taskDefinition.executionRoleArn,
        networkMode: taskDefinition.networkMode,
        containerDefinitions: nextContainerDefinitions,
        volumes: taskDefinition.volumes,
        placementConstraints: taskDefinition.placementConstraints,
        requiresCompatibilities: taskDefinition.requiresCompatibilities,
        cpu: taskDefinition.cpu,
        memory: taskDefinition.memory,
        pidMode: taskDefinition.pidMode,
        ipcMode: taskDefinition.ipcMode,
        proxyConfiguration: taskDefinition.proxyConfiguration,
        inferenceAccelerators: taskDefinition.inferenceAccelerators,
        runtimePlatform: taskDefinition.runtimePlatform,
        ephemeralStorage: taskDefinition.ephemeralStorage
      })
    );
    const nextTaskDefinitionArn = registered.taskDefinition?.taskDefinitionArn;
    if (!nextTaskDefinitionArn) {
      throw new AppError(500, "task_definition_register_failed", "Failed to register task definition");
    }

    const result = await this.client.send(
      new UpdateServiceCommand({
        cluster: env.clusterName,
        service: env.serviceName,
        taskDefinition: nextTaskDefinitionArn,
        forceNewDeployment: true
      })
    );
    return result.service?.taskDefinition;
  }

  public async rollbackToTaskDefinition(
    service: DeploymentService,
    environment: Environment,
    taskDefinitionArn: string
  ): Promise<string | undefined> {
    const env = environmentConfig(service, environment);
    const result = await this.client.send(
      new UpdateServiceCommand({
        cluster: env.clusterName,
        service: env.serviceName,
        taskDefinition: taskDefinitionArn,
        forceNewDeployment: true
      })
    );
    return result.service?.taskDefinition;
  }

  public async waitForStable(service: DeploymentService, environment: Environment): Promise<void> {
    const env = environmentConfig(service, environment);
    const result = await waitUntilServicesStable(
      { client: this.client, maxWaitTime: 300, minDelay: 5, maxDelay: 15 },
      { cluster: env.clusterName, services: [env.serviceName] }
    );

    if (result.state !== "SUCCESS") {
      throw new AppError(504, "ecs_not_stable", "ECS service did not stabilize before timeout");
    }
  }
}
