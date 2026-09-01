import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { signToken } from "./auth";
import { loadConfig } from "./config";
import { DeploymentCenterService } from "./deployment-service";
import type { DeploymentTrigger } from "./deployment-trigger";
import { createCloudAdapters } from "./integrations";
import { resetMockRegistry } from "./integrations/mock-adapters";
import { logger } from "./logger";
import { MemoryStore } from "./store/memory-store";

// loadServiceCatalog (config.ts) checks SERVICE_CATALOG_JSON and SERVICE_CATALOG_PATH before
// SERVICE_CATALOG, so all three must be controlled here or a value left over from the host
// environment (or a previous test file) silently changes which catalog these tests load.
const CATALOG_ENV_VARS = ["SERVICE_CATALOG", "SERVICE_CATALOG_JSON", "SERVICE_CATALOG_PATH"] as const;
const ORIGINAL_CATALOG_ENV: Record<(typeof CATALOG_ENV_VARS)[number], string | undefined> = {
  SERVICE_CATALOG: process.env.SERVICE_CATALOG,
  SERVICE_CATALOG_JSON: process.env.SERVICE_CATALOG_JSON,
  SERVICE_CATALOG_PATH: process.env.SERVICE_CATALOG_PATH
};

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

const openServers: Server[] = [];

afterAll(() => {
  for (const server of openServers) {
    server.close();
  }
});

const lockKey = "sample-service#dev";
const devRequest = {
  serviceId: "sample-service",
  environment: "dev" as const,
  imageTag: "dev-20260603-42-a1b2c3d",
  imageDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222"
};

// Trigger stub whose `.trigger()` always rejects, simulating LambdaDeploymentTrigger's
// InvokeCommand failing (IAM error, throttle, service outage, etc.).
class FailingTrigger implements DeploymentTrigger {
  public trigger(): Promise<void> {
    return Promise.reject(new Error("invoke boom"));
  }
}

// Trigger stub that records dispatched actions but never actually runs the worker, so route
// handlers can be asserted against without racing a real background execution.
class RecordingTrigger implements DeploymentTrigger {
  public calls: Array<{ action: string; deploymentId: string }> = [];

  public trigger(action: "execute-deployment" | "execute-rollback", deploymentId: string): Promise<void> {
    this.calls.push({ action, deploymentId });
    return Promise.resolve();
  }
}

async function startHarness(trigger: DeploymentTrigger = new FailingTrigger()) {
  for (const name of CATALOG_ENV_VARS) {
    delete process.env[name];
  }
  process.env.SERVICE_CATALOG = "sandbox";

  const config = loadConfig();
  const store = new MemoryStore(config);
  await store.ensureSeedAdmin();
  const cloud = createCloudAdapters(config, logger);
  const deploymentCenter = new DeploymentCenterService(config, store, cloud, logger);
  const app = createApp(config, store, deploymentCenter, logger, trigger);

  const server = app.listen(0);
  openServers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  const token = signToken({ userId: "admin", email: "admin@example.com", name: "Admin", role: "admin" }, config);

  return { store, deploymentCenter, port, token };
}

describe("POST /deployments trigger-dispatch failure", () => {
  it("returns 502, releases the lock, and marks the deployment failed (not stuck pending) when the trigger throws", async () => {
    const { store, port, token } = await startHarness();

    const response = await fetch(`http://127.0.0.1:${port}/deployments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(devRequest)
    });

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("deployment_trigger_failed");

    // Lock must be reacquirable: nothing is left holding it for the full TTL.
    await expect(
      store.acquireLock({
        lockKey,
        deploymentId: "lock-probe",
        createdAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + 900
      })
    ).resolves.toBe(true);

    // The pending record created by beginDeployment must not be stuck at "pending" — a client
    // polling GET /deployments/:id needs to see a terminal status.
    const deployments = await store.listDeployments();
    expect(deployments).toHaveLength(1);
    const [deployment] = deployments;
    expect(deployment?.status).toBe("failed");
    expect(deployment?.errorMessage).toBeTruthy();
  });
});

describe("POST /deployments/:deploymentId/rollback", () => {
  it("returns 202 with a running record and dispatches the trigger with execute-rollback", async () => {
    const trigger = new RecordingTrigger();
    const { deploymentCenter, port, token } = await startHarness(trigger);

    const completed = await deploymentCenter.createDeployment(devRequest, {
      userId: "admin",
      email: "admin@example.com",
      role: "admin"
    });
    expect(completed.status).toBe("succeeded");

    const response = await fetch(
      `http://127.0.0.1:${port}/deployments/${completed.deploymentId}/rollback`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` }
      }
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as { status: string; deploymentId: string };
    expect(body.status).toBe("running");
    expect(body.deploymentId).toBe(completed.deploymentId);
    expect(trigger.calls).toEqual([{ action: "execute-rollback", deploymentId: completed.deploymentId }]);
  });

  it("returns 502, releases the lock, and marks the deployment failed when the trigger throws", async () => {
    const { deploymentCenter, store, port, token } = await startHarness(new FailingTrigger());

    const completed = await deploymentCenter.createDeployment(devRequest, {
      userId: "admin",
      email: "admin@example.com",
      role: "admin"
    });
    expect(completed.status).toBe("succeeded");

    const response = await fetch(
      `http://127.0.0.1:${port}/deployments/${completed.deploymentId}/rollback`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` }
      }
    );

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rollback_trigger_failed");

    // Lock must be reacquirable: nothing is left holding it for the full TTL.
    await expect(
      store.acquireLock({
        lockKey,
        deploymentId: "lock-probe",
        createdAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + 900
      })
    ).resolves.toBe(true);

    const record = await store.getDeployment(completed.deploymentId);
    expect(record?.status).toBe("failed");
    expect(record?.errorMessage).toBeTruthy();
  });
});
