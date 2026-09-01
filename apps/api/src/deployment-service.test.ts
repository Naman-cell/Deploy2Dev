import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config";
import { DeploymentCenterService } from "./deployment-service";
import { createCloudAdapters } from "./integrations";
import { resetMockRegistry } from "./integrations/mock-adapters";
import type { CloudAdapters } from "./integrations/types";
import { logger } from "./logger";
import { MemoryStore } from "./store/memory-store";
import type { DataStore } from "./store/types";

// loadServiceCatalog (config.ts) checks SERVICE_CATALOG_JSON and SERVICE_CATALOG_PATH before
// SERVICE_CATALOG, so all three must be controlled here or a value left over from the host
// environment (or a previous test file) silently changes which catalog these tests load.
const CATALOG_ENV_VARS = ["SERVICE_CATALOG", "SERVICE_CATALOG_JSON", "SERVICE_CATALOG_PATH"] as const;
const ORIGINAL_CATALOG_ENV: Record<(typeof CATALOG_ENV_VARS)[number], string | undefined> = {
  SERVICE_CATALOG: process.env.SERVICE_CATALOG,
  SERVICE_CATALOG_JSON: process.env.SERVICE_CATALOG_JSON,
  SERVICE_CATALOG_PATH: process.env.SERVICE_CATALOG_PATH
};

async function createHarness(catalog: "sandbox" | "skillbrew" = "sandbox"): Promise<{
  service: DeploymentCenterService;
  cloud: CloudAdapters;
  store: DataStore;
}> {
  for (const name of CATALOG_ENV_VARS) {
    delete process.env[name];
  }
  if (catalog === "sandbox") {
    process.env.SERVICE_CATALOG = "sandbox";
  }

  const config = loadConfig();
  const store = new MemoryStore(config);
  await store.ensureSeedAdmin();
  const cloud = createCloudAdapters(config, logger);
  return { service: new DeploymentCenterService(config, store, cloud, logger), cloud, store };
}

beforeEach(() => {
  resetMockRegistry();
});

afterEach(() => {
  for (const name of CATALOG_ENV_VARS) {
    const original = ORIGINAL_CATALOG_ENV[name];
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }
});

describe("DeploymentCenterService", () => {
  it("rejects prod deployments for non-admin users", async () => {
    const { service } = await createHarness("sandbox");

    await expect(
      service.createDeployment(
        {
          serviceId: "sample-service",
          environment: "prod",
          imageTag: "stage-20260603-18-d4e5f6a",
          imageDigest: "sha256:3333333333333333333333333333333333333333333333333333333333333333"
        },
        { userId: "u1", email: "user@example.com", role: "user" }
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("creates a dev deployment and records events", async () => {
    const { service } = await createHarness("sandbox");
    const deployment = await service.createDeployment(
      {
        serviceId: "sample-service",
        environment: "dev",
        imageTag: "dev-20260603-42-a1b2c3d",
        imageDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222"
      },
      { userId: "admin", email: "admin@example.com", role: "admin" }
    );

    expect(deployment.status).toBe("succeeded");
    expect(deployment.events.map((event) => event.phase)).toContain("completed");
    expect(deployment.previousTaskDefinitionArn).toBeDefined();
  });

  describe("beginDeployment / executeDeployment split", () => {
    const adminActor = { userId: "admin", email: "admin@example.com", role: "admin" as const };
    const lockKey = "sample-service#dev";
    const devRequest = {
      serviceId: "sample-service",
      environment: "dev" as const,
      imageTag: "dev-20260603-42-a1b2c3d",
      imageDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222"
    };

    async function probeLockFree(store: DataStore): Promise<boolean> {
      return store.acquireLock({
        lockKey,
        deploymentId: "lock-probe",
        createdAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + 900
      });
    }

    it("beginDeployment persists a pending record without invoking any ECS/registry adapter, and holds the lock", async () => {
      const { service, cloud, store } = await createHarness("sandbox");
      const forceDeploySpy = vi.spyOn(cloud.ecs, "forceDeploy");
      const waitForStableSpy = vi.spyOn(cloud.ecs, "waitForStable");
      const promoteSpy = vi.spyOn(cloud.registry, "promoteEnvironmentTag");

      const deployment = await service.beginDeployment(devRequest, adminActor);

      expect(deployment.status).toBe("pending");
      expect(forceDeploySpy).not.toHaveBeenCalled();
      expect(waitForStableSpy).not.toHaveBeenCalled();
      expect(promoteSpy).not.toHaveBeenCalled();
      await expect(probeLockFree(store)).resolves.toBe(false);
    });

    it("beginDeployment throws 409 when the lock is already held", async () => {
      const { service } = await createHarness("sandbox");
      await service.beginDeployment(devRequest, adminActor);

      await expect(service.beginDeployment(devRequest, adminActor)).rejects.toMatchObject({
        statusCode: 409
      });
    });

    it("executeDeployment drives a pending deployment to succeeded and releases the lock", async () => {
      const { service, store } = await createHarness("sandbox");
      const deployment = await service.beginDeployment(devRequest, adminActor);

      const finished = await service.executeDeployment(deployment.deploymentId);

      expect(finished.status).toBe("succeeded");
      expect(finished.events.map((event) => event.phase)).toContain("completed");
      await expect(probeLockFree(store)).resolves.toBe(true);
    });

    it("executeDeployment marks the deployment failed (without rethrowing) on adapter error, and releases the lock", async () => {
      const { service, cloud, store } = await createHarness("sandbox");
      const deployment = await service.beginDeployment(devRequest, adminActor);
      vi.spyOn(cloud.ecs, "forceDeploy").mockRejectedValueOnce(new Error("ecs boom"));

      const finished = await service.executeDeployment(deployment.deploymentId);

      expect(finished.status).toBe("failed");
      expect(finished.errorMessage).toContain("ecs boom");
      await expect(probeLockFree(store)).resolves.toBe(true);
    });

    it("executeDeployment on an already-terminal deployment is a no-op", async () => {
      const { service, cloud } = await createHarness("sandbox");
      const deployment = await service.beginDeployment(devRequest, adminActor);
      const finished = await service.executeDeployment(deployment.deploymentId);
      expect(finished.status).toBe("succeeded");

      const forceDeploySpy = vi.spyOn(cloud.ecs, "forceDeploy");
      const waitForStableSpy = vi.spyOn(cloud.ecs, "waitForStable");
      const promoteSpy = vi.spyOn(cloud.registry, "promoteEnvironmentTag");

      const again = await service.executeDeployment(deployment.deploymentId);

      expect(again.status).toBe("succeeded");
      expect(again).toEqual(finished);
      expect(forceDeploySpy).not.toHaveBeenCalled();
      expect(waitForStableSpy).not.toHaveBeenCalled();
      expect(promoteSpy).not.toHaveBeenCalled();
    });

    it("executeDeployment on an unknown deployment id logs a warning and returns without throwing", async () => {
      const { service } = await createHarness("sandbox");

      const result = await service.executeDeployment("does-not-exist");

      expect(result.status).toBe("failed");
      expect(result.deploymentId).toBe("does-not-exist");
    });

    it("executeDeployment marks the deployment failed (without rethrowing) when the service has vanished from the catalog, and releases the lock", async () => {
      const { service, store } = await createHarness("sandbox");
      const ghostLockKey = "ghost-service#dev";
      const deploymentId = "ghost-deployment";
      const startedAt = new Date().toISOString();

      // Simulate catalog drift between beginDeployment and executeDeployment: persist a pending
      // record (and hold its lock) for a serviceId that is no longer in the service catalog this
      // DeploymentCenterService instance was constructed with.
      await store.acquireLock({
        lockKey: ghostLockKey,
        deploymentId,
        createdAt: startedAt,
        expiresAt: Math.floor(Date.now() / 1000) + 900
      });
      await store.saveDeployment({
        deploymentId,
        serviceId: "ghost-service",
        serviceName: "Ghost Service",
        environment: "dev",
        requestedBy: adminActor.userId,
        requestedByEmail: adminActor.email,
        selectedImageTag: "dev-20260603-42-a1b2c3d",
        selectedImageDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        status: "pending",
        startedAt,
        correlationId: "ghost-correlation",
        events: []
      });

      await expect(service.executeDeployment(deploymentId)).resolves.toMatchObject({
        status: "failed"
      });
      const result = await store.getDeployment(deploymentId);

      expect(result?.status).toBe("failed");
      expect(result?.errorMessage).toBeTruthy();
      await expect(
        store.acquireLock({
          lockKey: ghostLockKey,
          deploymentId: "lock-probe",
          createdAt: new Date().toISOString(),
          expiresAt: Math.floor(Date.now() / 1000) + 900
        })
      ).resolves.toBe(true);
    });
  });

  describe("beginRollback / executeRollback split", () => {
    const adminActor = { userId: "admin", email: "admin@example.com", role: "admin" as const };
    const lockKey = "sample-service#dev";
    const devRequest = {
      serviceId: "sample-service",
      environment: "dev" as const,
      imageTag: "dev-20260603-42-a1b2c3d",
      imageDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222"
    };

    async function probeLockFree(store: DataStore): Promise<boolean> {
      return store.acquireLock({
        lockKey,
        deploymentId: "lock-probe",
        createdAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + 900
      });
    }

    async function createRollbackCandidate(service: DeploymentCenterService) {
      const completed = await service.createDeployment(devRequest, adminActor);
      expect(completed.status).toBe("succeeded");
      expect(completed.previousTaskDefinitionArn).toBeDefined();
      return completed;
    }

    it("beginRollback persists a running record without invoking ECS, and holds the lock", async () => {
      const { service, cloud, store } = await createHarness("sandbox");
      const completed = await createRollbackCandidate(service);

      const rollbackSpy = vi.spyOn(cloud.ecs, "rollbackToTaskDefinition");
      const waitForStableSpy = vi.spyOn(cloud.ecs, "waitForStable");

      const deployment = await service.beginRollback(completed.deploymentId, adminActor);

      expect(deployment.status).toBe("running");
      expect(rollbackSpy).not.toHaveBeenCalled();
      expect(waitForStableSpy).not.toHaveBeenCalled();
      await expect(probeLockFree(store)).resolves.toBe(false);
    });

    it("beginRollback throws 400 when previousTaskDefinitionArn is absent", async () => {
      const { service, store } = await createHarness("sandbox");
      const startedAt = new Date().toISOString();
      await store.saveDeployment({
        deploymentId: "no-previous-taskdef",
        serviceId: "sample-service",
        serviceName: "Sample Service",
        environment: "dev",
        requestedBy: adminActor.userId,
        requestedByEmail: adminActor.email,
        selectedImageTag: "dev-20260603-42-a1b2c3d",
        selectedImageDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        status: "succeeded",
        startedAt,
        completedAt: startedAt,
        correlationId: "no-previous-taskdef",
        events: []
      });

      await expect(service.beginRollback("no-previous-taskdef", adminActor)).rejects.toMatchObject({
        statusCode: 400
      });
    });

    it("beginRollback throws 409 when the lock is already held", async () => {
      const { service, store } = await createHarness("sandbox");
      const completed = await createRollbackCandidate(service);
      await store.acquireLock({
        lockKey,
        deploymentId: "someone-else",
        createdAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + 900
      });

      await expect(service.beginRollback(completed.deploymentId, adminActor)).rejects.toMatchObject({
        statusCode: 409
      });
    });

    it("executeRollback drives a running rollback to rolled_back and releases the lock", async () => {
      const { service, store } = await createHarness("sandbox");
      const completed = await createRollbackCandidate(service);
      const started = await service.beginRollback(completed.deploymentId, adminActor);

      const finished = await service.executeRollback(started.deploymentId);

      expect(finished.status).toBe("rolled_back");
      expect(finished.events.map((event) => event.phase)).toContain("rollback_completed");
      await expect(probeLockFree(store)).resolves.toBe(true);
    });

    it("executeRollback marks the deployment failed (without rethrowing) on adapter error, and releases the lock", async () => {
      const { service, cloud, store } = await createHarness("sandbox");
      const completed = await createRollbackCandidate(service);
      const started = await service.beginRollback(completed.deploymentId, adminActor);
      vi.spyOn(cloud.ecs, "rollbackToTaskDefinition").mockRejectedValueOnce(new Error("rollback boom"));

      const finished = await service.executeRollback(started.deploymentId);

      expect(finished.status).toBe("failed");
      expect(finished.errorMessage).toContain("rollback boom");
      await expect(probeLockFree(store)).resolves.toBe(true);
    });

    it("executeRollback on an already-terminal deployment is a no-op", async () => {
      const { service, cloud } = await createHarness("sandbox");
      const completed = await createRollbackCandidate(service);
      const started = await service.beginRollback(completed.deploymentId, adminActor);
      const finished = await service.executeRollback(started.deploymentId);
      expect(finished.status).toBe("rolled_back");

      const rollbackSpy = vi.spyOn(cloud.ecs, "rollbackToTaskDefinition");
      const waitForStableSpy = vi.spyOn(cloud.ecs, "waitForStable");

      const again = await service.executeRollback(started.deploymentId);

      expect(again.status).toBe("rolled_back");
      expect(again).toEqual(finished);
      expect(rollbackSpy).not.toHaveBeenCalled();
      expect(waitForStableSpy).not.toHaveBeenCalled();
    });

    it("rollback (thin wrapper) drives begin+execute to a terminal rolled_back record", async () => {
      const { service } = await createHarness("sandbox");
      const completed = await createRollbackCandidate(service);

      const result = await service.rollback(completed.deploymentId, adminActor);

      expect(result.status).toBe("rolled_back");
    });
  });

  describe("SkillBrew catalog environment tag wiring", () => {
    const adminActor = { userId: "admin", email: "admin@example.com", role: "admin" as const };
    const userActor = { userId: "user", email: "user@example.com", role: "user" as const };

    // Each case below deploys an artifact whose digest differs from the target environment's
    // seed default, so a successful `findRelease` lookup under the expected tag can only pass if
    // `promoteEnvironmentTag` actually wrote the digest under that tag (not merely inherited it
    // from the pre-seeded pointer digest). The `resetMockRegistry()` call in `beforeEach` above
    // additionally guarantees each test starts from a clean mock registry, so isolation here is
    // structural rather than dependent on this digest choice alone.

    it("deploying django_app to stage promotes the wire tag stg, not stage", async () => {
      const { service, cloud } = await createHarness("skillbrew");
      const djangoApp = service.getService("django_app");
      const digest = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

      const deployment = await service.createDeployment(
        {
          serviceId: "django_app",
          environment: "stage",
          imageTag: "dev-20260603-42-a1b2c3d",
          imageDigest: digest
        },
        adminActor
      );

      expect(deployment.status).toBe("succeeded");
      await expect(cloud.registry.findRelease(djangoApp, "stg", digest)).resolves.toBeDefined();
      await expect(cloud.registry.findRelease(djangoApp, "stage", digest)).resolves.toBeUndefined();
    });

    it("deploying admin_app to stage promotes the wire tag staging", async () => {
      const { service, cloud } = await createHarness("skillbrew");
      const adminApp = service.getService("admin_app");
      const digest = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

      const deployment = await service.createDeployment(
        {
          serviceId: "admin_app",
          environment: "stage",
          imageTag: "dev-20260603-42-a1b2c3d",
          imageDigest: digest
        },
        adminActor
      );

      expect(deployment.status).toBe("succeeded");
      await expect(cloud.registry.findRelease(adminApp, "staging", digest)).resolves.toBeDefined();
      await expect(cloud.registry.findRelease(adminApp, "stg", digest)).resolves.toBeUndefined();
    });

    it("deploying to dev promotes the wire tag dev", async () => {
      const { service, cloud } = await createHarness("skillbrew");
      const djangoApp = service.getService("django_app");
      const digest = "sha256:4444444444444444444444444444444444444444444444444444444444444444";

      const deployment = await service.createDeployment(
        {
          serviceId: "django_app",
          environment: "dev",
          imageTag: "hotfix-20260603-7-ab12cd3",
          imageDigest: digest
        },
        adminActor
      );

      expect(deployment.status).toBe("succeeded");
      await expect(cloud.registry.findRelease(djangoApp, "dev", digest)).resolves.toBeDefined();
    });

    it("deploying to prod promotes the wire tag prod", async () => {
      const { service, cloud } = await createHarness("skillbrew");
      const djangoApp = service.getService("django_app");
      const digest = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

      const deployment = await service.createDeployment(
        {
          serviceId: "django_app",
          environment: "prod",
          imageTag: "branch-feature-login-a1b2c3d",
          imageDigest: digest
        },
        adminActor
      );

      expect(deployment.status).toBe("succeeded");
      await expect(cloud.registry.findRelease(djangoApp, "prod", digest)).resolves.toBeDefined();
    });

    it("still rejects prod deployments for non-admin users on the SkillBrew catalog", async () => {
      const { service } = await createHarness("skillbrew");

      await expect(
        service.createDeployment(
          {
            serviceId: "django_app",
            environment: "prod",
            imageTag: "hotfix-20260603-7-ab12cd3",
            imageDigest: "sha256:4444444444444444444444444444444444444444444444444444444444444444"
          },
          userActor
        )
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });
});
