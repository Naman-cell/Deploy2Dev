import {
  canDeploy,
  CreateDeploymentRequestSchema,
  type Deployment,
  type DeploymentEvent,
  type DeploymentService,
  type Environment,
  type Release,
  type Role
} from "@heimdall/shared";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config";
import { AppError } from "./errors";
import type { CloudAdapters } from "./integrations/types";
import type { Logger } from "./logger";
import type { DataStore } from "./store/types";

interface Actor {
  userId: string;
  email: string;
  role: Role;
}

export class DeploymentCenterService {
  public constructor(
    private readonly config: AppConfig,
    private readonly store: DataStore,
    private readonly cloud: CloudAdapters,
    private readonly logger: Logger
  ) {}

  public listServices(): DeploymentService[] {
    return this.config.services;
  }

  public getService(serviceId: string): DeploymentService {
    const service = this.config.services.find((candidate) => candidate.serviceId === serviceId);
    if (!service) {
      throw new AppError(404, "service_not_found", "Service was not found");
    }
    return service;
  }

  public async listReleases(serviceId: string, environment: Environment): Promise<Release[]> {
    const service = this.getService(serviceId);
    return this.cloud.registry.listReleases(service, environment);
  }

  public async currentState(serviceId: string, environment: Environment) {
    const service = this.getService(serviceId);
    const [ecsState, environmentImageDigest] = await Promise.all([
      this.cloud.ecs.getCurrentState(service, environment),
      this.cloud.registry.getEnvironmentDigest(service, environment)
    ]);

    return { ...ecsState, environmentImageDigest };
  }

  public async createDeployment(input: unknown, actor: Actor): Promise<Deployment> {
    const request = CreateDeploymentRequestSchema.parse(input);
    const service = this.getService(request.serviceId);

    this.assertDeployAllowed(actor.role, request.environment);

    const releases = await this.cloud.registry.listReleases(service, request.environment);
    const selected = releases.find(
      (release) => release.tag === request.imageTag && release.digest === request.imageDigest
    );
    if (!selected) {
      throw new AppError(404, "release_not_found", "Selected release was not found in ECR");
    }

    const deploymentId = randomUUID();
    const correlationId = randomUUID();
    const startedAt = new Date().toISOString();
    const lockKey = `${service.serviceId}#${request.environment}`;

    const lockAcquired = await this.store.acquireLock({
      lockKey,
      deploymentId,
      createdAt: startedAt,
      expiresAt: Math.floor(Date.now() / 1000) + 900
    });
    if (!lockAcquired) {
      throw new AppError(409, "deployment_in_progress", "A deployment is already running");
    }

    const deployment: Deployment = {
      deploymentId,
      serviceId: service.serviceId,
      serviceName: service.name,
      environment: request.environment,
      requestedBy: actor.userId,
      requestedByEmail: actor.email,
      selectedImageTag: selected.tag,
      selectedImageDigest: selected.digest,
      status: "pending",
      startedAt,
      correlationId,
      events: []
    };

    await this.store.saveDeployment(deployment);

    try {
      await this.event(deployment, "validated", "running", "Deployment request validated");
      const previousState = await this.currentState(service.serviceId, request.environment);
      deployment.previousEnvironmentImageDigest = previousState.environmentImageDigest;
      deployment.previousTaskDefinitionArn = previousState.currentTaskDefinitionArn;
      deployment.status = "running";
      await this.store.updateDeployment(deployment);

      await this.event(deployment, "promote_environment_tag", "running", "Promoting environment tag", {
        environment: request.environment,
        selectedImageDigest: selected.digest
      });
      await this.cloud.registry.promoteEnvironmentTag(service, request.environment, selected.digest);

      await this.event(deployment, "ecs_force_deploy", "running", "Forcing ECS deployment");
      deployment.newTaskDefinitionArn = await this.cloud.ecs.forceDeploy(service, request.environment);
      await this.store.updateDeployment(deployment);

      await this.event(deployment, "ecs_wait_stable", "running", "Waiting for ECS service stability");
      await this.cloud.ecs.waitForStable(service, request.environment);

      deployment.status = "succeeded";
      deployment.completedAt = new Date().toISOString();
      await this.store.updateDeployment(deployment);
      await this.event(deployment, "completed", "succeeded", "Deployment completed");
      return deployment;
    } catch (error) {
      deployment.status = "failed";
      deployment.completedAt = new Date().toISOString();
      deployment.errorMessage = error instanceof Error ? error.message : "Unknown deployment error";
      await this.store.updateDeployment(deployment);
      await this.event(deployment, "failed", "failed", deployment.errorMessage);
      this.logger.error("deployment failed", { deploymentId, correlationId, error: deployment.errorMessage });
      throw error;
    } finally {
      await this.store.releaseLock(lockKey, deploymentId);
    }
  }

  public async rollback(deploymentId: string, actor: Actor): Promise<Deployment> {
    const deployment = await this.store.getDeployment(deploymentId);
    if (!deployment) {
      throw new AppError(404, "deployment_not_found", "Deployment was not found");
    }
    this.assertDeployAllowed(actor.role, deployment.environment);

    const service = this.getService(deployment.serviceId);
    if (!deployment.previousTaskDefinitionArn) {
      throw new AppError(400, "rollback_unavailable", "No previous task definition was recorded");
    }

    await this.event(deployment, "rollback_started", "running", "Rollback requested", {
      requestedBy: actor.email
    });

    await this.cloud.ecs.rollbackToTaskDefinition(
      service,
      deployment.environment,
      deployment.previousTaskDefinitionArn
    );
    await this.cloud.ecs.waitForStable(service, deployment.environment);

    deployment.status = "rolled_back";
    deployment.completedAt = new Date().toISOString();
    await this.store.updateDeployment(deployment);
    await this.event(deployment, "rollback_completed", "rolled_back", "Rollback completed");
    return deployment;
  }

  private assertDeployAllowed(role: Role, environment: Environment): void {
    if (!canDeploy(role, environment)) {
      throw new AppError(403, "deployment_not_allowed", "You are not allowed to deploy this environment");
    }
  }

  private async event(
    deployment: Deployment,
    phase: string,
    status: DeploymentEvent["status"],
    message: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const event: DeploymentEvent = {
      deploymentId: deployment.deploymentId,
      timestamp: new Date().toISOString(),
      phase,
      status,
      message,
      metadata
    };
    deployment.events.push(event);
    await this.store.appendDeploymentEvent(event);
    this.logger.info("deployment event", {
      deploymentId: deployment.deploymentId,
      correlationId: deployment.correlationId,
      phase,
      status
    });
  }
}
