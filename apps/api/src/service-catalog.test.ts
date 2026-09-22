import { ServiceSchema } from "@heimdall/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import catalog from "./service-catalog.json" with { type: "json" };

const ServiceCatalogSchema = z.array(ServiceSchema);

describe("service-catalog.json", () => {
  it("parses against the ServiceSchema array", () => {
    const result = ServiceCatalogSchema.safeParse(catalog);
    expect(result.success).toBe(true);
  });

  const services = ServiceCatalogSchema.parse(catalog);

  it("has exactly 13 services", () => {
    expect(services).toHaveLength(13);
  });

  it("excludes nginx", () => {
    expect(services.find((service) => service.serviceId === "nginx")).toBeUndefined();
  });

  const tfEnvByEnvironment = {
    dev: "dev",
    stage: "staging",
    prod: "prod"
  } as const;

  it("derives every taskFamily from skillbrew-{tfEnv}-{serviceName}", () => {
    for (const service of services) {
      for (const [environment, tfEnv] of Object.entries(tfEnvByEnvironment)) {
        const envConfig = service.environments[environment as keyof typeof tfEnvByEnvironment];
        expect(envConfig, `${service.serviceId} missing environment ${environment}`).toBeDefined();
        if (!envConfig) {
          continue;
        }
        expect(envConfig.taskFamily).toBe(`skillbrew-${tfEnv}-${envConfig.serviceName}`);
      }
    }
  });

  it("uses stg for every stage environmentTag except admin_app, which uses staging", () => {
    for (const service of services) {
      const stageConfig = service.environments.stage;
      expect(stageConfig, `${service.serviceId} missing stage environment`).toBeDefined();
      if (!stageConfig) {
        continue;
      }
      if (service.serviceId === "admin_app") {
        expect(stageConfig.environmentTag).toBe("staging");
      } else {
        expect(stageConfig.environmentTag).toBe("stg");
      }
    }
  });

  it("restricts prod deploys to admins only", () => {
    for (const service of services) {
      expect(service.allowedDeployRolesByEnvironment.prod).toEqual(["admin"]);
    }
  });

  it("configures preprod for every service, running on the stage ECS cluster/service/taskFamily with its own preprod tag", () => {
    for (const service of services) {
      const stageConfig = service.environments.stage;
      const preprodConfig = service.environments.preprod;
      expect(preprodConfig, `${service.serviceId} missing preprod environment`).toBeDefined();
      expect(stageConfig, `${service.serviceId} missing stage environment`).toBeDefined();
      if (!preprodConfig || !stageConfig) {
        continue;
      }
      expect(preprodConfig.clusterName).toBe(stageConfig.clusterName);
      expect(preprodConfig.serviceName).toBe(stageConfig.serviceName);
      expect(preprodConfig.taskFamily).toBe(stageConfig.taskFamily);
      expect(preprodConfig.environmentTag).toBe("preprod");
    }
  });

  it("restricts preprod deploys to admins only", () => {
    for (const service of services) {
      expect(service.allowedDeployRolesByEnvironment.preprod).toEqual(["admin"]);
    }
  });
});
