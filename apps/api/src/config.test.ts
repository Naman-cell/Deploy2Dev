import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const CATALOG_ENV_VARS = [
  "SERVICE_CATALOG",
  "SERVICE_CATALOG_JSON",
  "SERVICE_CATALOG_PATH"
] as const;
const ORIGINAL_CATALOG_ENV: Record<(typeof CATALOG_ENV_VARS)[number], string | undefined> = {
  SERVICE_CATALOG: process.env.SERVICE_CATALOG,
  SERVICE_CATALOG_JSON: process.env.SERVICE_CATALOG_JSON,
  SERVICE_CATALOG_PATH: process.env.SERVICE_CATALOG_PATH
};

function clearCatalogEnv(): void {
  for (const name of CATALOG_ENV_VARS) {
    delete process.env[name];
  }
}

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

describe("loadServiceCatalog validation", () => {
  it("rejects an empty service catalog instead of silently loading zero services", () => {
    clearCatalogEnv();
    process.env.SERVICE_CATALOG_JSON = "[]";

    expect(() => loadConfig()).toThrow(/at least one service/i);
  });

  it("rejects a service with zero configured environments", () => {
    clearCatalogEnv();
    process.env.SERVICE_CATALOG_JSON = JSON.stringify([
      {
        serviceId: "no-envs",
        name: "No Envs",
        githubRepository: "Brudite-Pvt-Ltd/no-envs",
        ecrRepository: "no-envs",
        containerName: "no-envs",
        environments: {},
        allowedDeployRolesByEnvironment: {}
      }
    ]);

    expect(() => loadConfig()).toThrow(/no-envs.*no configured environments/i);
  });

  it("still accepts a service configured for only a subset of environments", () => {
    clearCatalogEnv();
    process.env.SERVICE_CATALOG_JSON = JSON.stringify([
      {
        serviceId: "dev-only",
        name: "Dev Only",
        githubRepository: "Brudite-Pvt-Ltd/dev-only",
        ecrRepository: "dev-only",
        containerName: "dev-only",
        environments: {
          dev: {
            clusterName: "dev-cluster",
            serviceName: "dev-only",
            taskFamily: "dev-only-task",
            environmentTag: "dev"
          }
        },
        allowedDeployRolesByEnvironment: {
          dev: ["admin", "user"]
        }
      }
    ]);

    const config = loadConfig();
    expect(config.services).toHaveLength(1);
    expect(config.services[0]?.serviceId).toBe("dev-only");
  });
});

describe("bundled SkillBrew catalog preprod environment", () => {
  it("exposes preprod, restricted to admins, for every bundled service", () => {
    clearCatalogEnv();

    const config = loadConfig();

    expect(config.services.length).toBeGreaterThan(0);
    for (const service of config.services) {
      expect(
        service.environments.preprod,
        `${service.serviceId} missing preprod environment`
      ).toBeDefined();
      expect(service.allowedDeployRolesByEnvironment.preprod).toEqual(["admin"]);
    }
  });
});

describe("sandbox catalog preprod environment", () => {
  it("rides on the stage ECS service with a distinct preprod image tag, restricted to admins", () => {
    clearCatalogEnv();
    process.env.SERVICE_CATALOG = "sandbox";

    const config = loadConfig();

    expect(config.services).toHaveLength(1);
    const sandboxService = config.services[0];
    expect(sandboxService).toBeDefined();
    expect(Object.keys(sandboxService?.environments ?? {}).sort()).toEqual([
      "dev",
      "preprod",
      "prod",
      "stage"
    ]);

    const stageEnv = sandboxService?.environments.stage;
    const preprodEnv = sandboxService?.environments.preprod;
    expect(preprodEnv).toBeDefined();
    expect(preprodEnv?.clusterName).toBe(stageEnv?.clusterName);
    expect(preprodEnv?.serviceName).toBe(stageEnv?.serviceName);
    expect(preprodEnv?.taskFamily).toBe(stageEnv?.taskFamily);
    expect(preprodEnv?.environmentTag).toBe("preprod");

    expect(sandboxService?.allowedDeployRolesByEnvironment.preprod).toEqual(["admin"]);
  });
});
