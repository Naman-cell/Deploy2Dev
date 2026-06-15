import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { DeploymentCenterService } from "./deployment-service";
import { createCloudAdapters } from "./integrations";
import { logger } from "./logger";
import { MemoryStore } from "./store/memory-store";

async function createService() {
  const config = loadConfig();
  const store = new MemoryStore(config);
  await store.ensureSeedAdmin();
  return new DeploymentCenterService(config, store, createCloudAdapters(config), logger);
}

describe("DeploymentCenterService", () => {
  it("rejects prod deployments for non-admin users", async () => {
    const service = await createService();

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
    const service = await createService();
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
});
