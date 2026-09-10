import {
  canDeploy,
  CreateDeploymentRequestSchema,
  type Deployment,
  type DeploymentEvent,
  type DeploymentService,
  type Environment,
  isReleaseEligibleForEnvironment,
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

  // `environment` is kept in the public signature (and validated by the route) for API
  // stability, but releases are not filtered per environment: the registry adapter returns
  // every release for the service regardless of environment.
  public async listReleases(serviceId: string, _environment: Environment): Promise<Release[]> {
    const service = this.getService(serviceId);
    return this.cloud.registry.listReleases(service);
  }

  public async currentState(serviceId: string, environment: Environment) {
    const service = this.getService(serviceId);
    const [ecsState, environmentImageDigest] = await Promise.all([
      this.cloud.ecs.getCurrentState(service, environment),
      this.cloud.registry.getEnvironmentDigest(service, environment)
    ]);

    return { ...ecsState, environmentImageDigest };
  }

  // Validates the request, acquires the per-service+environment lock, and persists a `pending`
  // deployment record. Deliberately does NOT touch ECS/ECR — this is the fast synchronous half of
  // deploy so the route handler can return before API Gateway's 30s timeout. Callers must follow
  // up with `executeDeployment` to actually run the rollout.
  public async beginDeployment(input: unknown, actor: Actor): Promise<Deployment> {
    const request = CreateDeploymentRequestSchema.parse(input);
    const service = this.getService(request.serviceId);

    this.assertDeployAllowed(actor.role, request.environment);

    const selected = await this.cloud.registry.findRelease(
      service,
      request.imageTag,
      request.imageDigest
    );
    if (!selected) {
      throw new AppError(404, "release_not_found", "Selected release was not found in ECR");
    }

    if (!isReleaseEligibleForEnvironment(request.environment, selected)) {
      throw new AppError(
        422,
        "release_branch_required",
        `The ${request.environment} environment only accepts images built from a release branch (main or release/*). Selected image branch: ${selected.sourceBranch ?? "unknown"}.`
      );
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

    try {
      await this.store.saveDeployment(deployment);
    } catch (error) {
      // Don't leak the lock if persisting the pending record failed.
      await this.store.releaseLock(lockKey, deploymentId);
      throw error;
    }

    return deployment;
  }

  // Runs the actual ECS rollout for a previously-`beginDeployment`'d record. Designed to be
  // invoked out-of-band (fire-and-forget in-process, or as an async Lambda self-invocation) so it
  // is not bound by the API Gateway request timeout. Never rethrows on rollout failure — an
  // uncaught throw here would trigger a Lambda async-invocation retry, which would re-run ECS
  // rollout for an already-attempted deployment.
  public async executeDeployment(deploymentId: string): Promise<Deployment> {
    const deployment = await this.store.getDeployment(deploymentId);
    if (!deployment) {
      // Nothing to run and nothing to persist against — most likely a stale/invalid worker
      // invocation. Per contract this must not throw (a Lambda async-invocation retry would just
      // hit the same missing record again), so synthesize a terminal placeholder record instead.
      this.logger.warn("executeDeployment: deployment not found", { deploymentId });
      const now = new Date().toISOString();
      return {
        deploymentId,
        serviceId: "",
        serviceName: "",
        environment: "dev",
        requestedBy: "",
        requestedByEmail: "",
        selectedImageTag: "",
        selectedImageDigest: "",
        status: "failed",
        startedAt: now,
        completedAt: now,
        errorMessage: "Deployment record not found",
        correlationId: deploymentId,
        events: []
      };
    }

    if (deployment.status === "succeeded" || deployment.status === "failed" || deployment.status === "rolled_back") {
      this.logger.warn("executeDeployment: deployment already terminal, skipping", {
        deploymentId,
        status: deployment.status
      });
      return deployment;
    }

    const lockKey = `${deployment.serviceId}#${deployment.environment}`;

    try {
      const service = this.getService(deployment.serviceId);
      await this.event(deployment, "validated", "running", "Deployment request validated");
      const previousState = await this.currentState(deployment.serviceId, deployment.environment);
      deployment.previousEnvironmentImageDigest = previousState.environmentImageDigest;
      deployment.previousTaskDefinitionArn = previousState.currentTaskDefinitionArn;
      deployment.status = "running";
      await this.store.updateDeployment(deployment);

      await this.event(deployment, "promote_environment_tag", "running", "Promoting environment tag", {
        environment: deployment.environment,
        selectedImageDigest: deployment.selectedImageDigest
      });
      await this.cloud.registry.promoteEnvironmentTag(
        service,
        deployment.environment,
        deployment.selectedImageDigest
      );

      await this.event(deployment, "ecs_force_deploy", "running", "Forcing ECS deployment");
      deployment.newTaskDefinitionArn = await this.cloud.ecs.forceDeploy(service, deployment.environment);
      await this.store.updateDeployment(deployment);

      await this.event(deployment, "ecs_wait_stable", "running", "Waiting for ECS service stability");
      await this.waitForEcsStable(service, deployment);

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
      this.logger.error("deployment failed", {
        deploymentId,
        correlationId: deployment.correlationId,
        error: deployment.errorMessage
      });
      return deployment;
    } finally {
      await this.store.releaseLock(lockKey, deploymentId);
    }
  }

  // Thin synchronous convenience wrapper kept for existing callers/tests that expect
  // `createDeployment` to run begin+execute and resolve with the final terminal record.
  public async createDeployment(input: unknown, actor: Actor): Promise<Deployment> {
    const started = await this.beginDeployment(input, actor);
    return this.executeDeployment(started.deploymentId);
  }

  // Companion to `beginDeployment` for when dispatching the async worker (the trigger, not the
  // rollout itself) fails: releases the per-service+environment lock `beginDeployment` acquired
  // and marks the still-`pending` record `failed` so it doesn't stay stuck for a client polling
  // `GET /deployments/:id`, and so a retry to the same service+environment isn't 409-blocked by a
  // lock nothing will ever release. Mirrors the lock-key derivation and failure bookkeping used in
  // `beginDeployment`'s persist-failure path and `executeDeployment`'s catch block.
  public async failDeploymentStart(deployment: Deployment, reason: string): Promise<void> {
    const lockKey = `${deployment.serviceId}#${deployment.environment}`;
    await this.store.releaseLock(lockKey, deployment.deploymentId);

    deployment.status = "failed";
    deployment.completedAt = new Date().toISOString();
    deployment.errorMessage = reason;
    await this.store.updateDeployment(deployment);
    await this.event(deployment, "failed", "failed", reason);
  }

  // Validates the rollback request and acquires the per-service+environment lock (mirrors
  // `beginDeployment`). Deliberately does NOT touch ECS — this is the fast synchronous half of
  // rollback so the route handler can return before API Gateway's 30s timeout. Callers must follow
  // up with `executeRollback` to actually run the rollback. Acquiring the same lock key as
  // `beginDeployment` prevents a rollback racing a deploy on the same service+environment.
  public async beginRollback(deploymentId: string, actor: Actor): Promise<Deployment> {
    const deployment = await this.store.getDeployment(deploymentId);
    if (!deployment) {
      throw new AppError(404, "deployment_not_found", "Deployment was not found");
    }
    this.assertDeployAllowed(actor.role, deployment.environment);

    // Validates the service still exists in the catalog (throws 404 otherwise); the actual
    // rollback call happens later in `executeRollback`.
    this.getService(deployment.serviceId);
    if (!deployment.previousTaskDefinitionArn) {
      throw new AppError(400, "rollback_unavailable", "No previous task definition was recorded");
    }

    const lockKey = `${deployment.serviceId}#${deployment.environment}`;
    const lockAcquired = await this.store.acquireLock({
      lockKey,
      deploymentId,
      createdAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + 900
    });
    if (!lockAcquired) {
      throw new AppError(409, "deployment_in_progress", "A deployment is already running");
    }

    try {
      deployment.status = "running";
      await this.store.updateDeployment(deployment);
      await this.event(deployment, "rollback_started", "running", "Rollback requested", {
        requestedBy: actor.email
      });
    } catch (error) {
      // Don't leak the lock if persisting the running state failed.
      await this.store.releaseLock(lockKey, deploymentId);
      throw error;
    }

    return deployment;
  }

  // Runs the actual ECS rollback for a previously-`beginRollback`'d record. Designed to be invoked
  // out-of-band (fire-and-forget in-process, or as an async Lambda self-invocation) so it is not
  // bound by the API Gateway request timeout. Never rethrows on rollback failure — an uncaught
  // throw here would trigger a Lambda async-invocation retry, which would re-run the rollback for
  // an already-attempted deployment.
  public async executeRollback(deploymentId: string): Promise<Deployment> {
    const deployment = await this.store.getDeployment(deploymentId);
    if (!deployment) {
      this.logger.warn("executeRollback: deployment not found", { deploymentId });
      const now = new Date().toISOString();
      return {
        deploymentId,
        serviceId: "",
        serviceName: "",
        environment: "dev",
        requestedBy: "",
        requestedByEmail: "",
        selectedImageTag: "",
        selectedImageDigest: "",
        status: "failed",
        startedAt: now,
        completedAt: now,
        errorMessage: "Deployment record not found",
        correlationId: deploymentId,
        events: []
      };
    }

    if (deployment.status === "succeeded" || deployment.status === "failed" || deployment.status === "rolled_back") {
      this.logger.warn("executeRollback: deployment already terminal, skipping", {
        deploymentId,
        status: deployment.status
      });
      return deployment;
    }

    const lockKey = `${deployment.serviceId}#${deployment.environment}`;

    try {
      const service = this.getService(deployment.serviceId);
      if (!deployment.previousTaskDefinitionArn) {
        throw new AppError(400, "rollback_unavailable", "No previous task definition was recorded");
      }

      await this.cloud.ecs.rollbackToTaskDefinition(
        service,
        deployment.environment,
        deployment.previousTaskDefinitionArn
      );
      await this.waitForEcsStable(service, deployment);

      deployment.status = "rolled_back";
      deployment.completedAt = new Date().toISOString();
      await this.store.updateDeployment(deployment);
      await this.event(deployment, "rollback_completed", "rolled_back", "Rollback completed");
      return deployment;
    } catch (error) {
      deployment.status = "failed";
      deployment.completedAt = new Date().toISOString();
      deployment.errorMessage = error instanceof Error ? error.message : "Unknown rollback error";
      await this.store.updateDeployment(deployment);
      await this.event(deployment, "rollback_failed", "failed", deployment.errorMessage);
      this.logger.error("rollback failed", {
        deploymentId,
        correlationId: deployment.correlationId,
        error: deployment.errorMessage
      });
      return deployment;
    } finally {
      await this.store.releaseLock(lockKey, deploymentId);
    }
  }

  // Thin synchronous convenience wrapper kept for existing callers/tests that expect `rollback` to
  // run begin+execute and resolve with the final terminal record. Since `beginRollback` sets
  // `status` to `running` (not terminal) before `executeRollback` runs, the idempotency guard at
  // the top of `executeRollback` does not short-circuit this composition.
  public async rollback(deploymentId: string, actor: Actor): Promise<Deployment> {
    const started = await this.beginRollback(deploymentId, actor);
    return this.executeRollback(started.deploymentId);
  }

  private assertDeployAllowed(role: Role, environment: Environment): void {
    if (!canDeploy(role, environment)) {
      throw new AppError(403, "deployment_not_allowed", "You are not allowed to deploy this environment");
    }
  }

  // Waits for the ECS service to stabilize, streaming deduped `ecs_wait_stable` progress events as
  // the rollout advances (poll snapshots that are identical to the previous one are dropped so
  // callers see distinct log lines, not a flood of repeats every poll interval).
  private async waitForEcsStable(service: DeploymentService, deployment: Deployment): Promise<void> {
    let lastKey: string | undefined;
    await this.cloud.ecs.waitForStable(service, deployment.environment, async (progress) => {
      const key = `${progress.rolloutState}|${progress.runningCount}|${progress.desiredCount}|${progress.pendingCount}|${progress.lastServiceEvent}`;
      if (key === lastKey) {
        return;
      }
      lastKey = key;
      await this.event(deployment, "ecs_wait_stable", "running", progress.message, {
        rolloutState: progress.rolloutState,
        runningCount: progress.runningCount,
        desiredCount: progress.desiredCount,
        pendingCount: progress.pendingCount,
        lastServiceEvent: progress.lastServiceEvent
      });
    });
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
