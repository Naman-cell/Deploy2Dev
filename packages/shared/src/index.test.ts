import { describe, expect, it } from "vitest";
import type { DeploymentService } from "./index";
import { canDeploy, classifyReleaseTag, environmentPointerTags } from "./index";

describe("shared deployment policy helpers", () => {
  it("allows only admins to deploy prod", () => {
    expect(canDeploy("admin", "prod")).toBe(true);
    expect(canDeploy("user", "prod")).toBe(false);
  });

  it("allows only admins to deploy preprod", () => {
    expect(canDeploy("admin", "preprod")).toBe(true);
    expect(canDeploy("user", "preprod")).toBe(false);
  });

  it("allows users and admins to deploy non-prod environments", () => {
    expect(canDeploy("user", "dev")).toBe(true);
    expect(canDeploy("user", "stage")).toBe(true);
    expect(canDeploy("admin", "stage")).toBe(true);
  });

  it("classifies Skillbrew release tags", () => {
    expect(classifyReleaseTag("branch-feature-auth-a1b2c3d")).toBe("manual");
    expect(classifyReleaseTag("dev-20260603-42-a1b2c3d")).toBe("dev");
    expect(classifyReleaseTag("stage-20260603-18-d4e5f6a")).toBe("stage");
    expect(classifyReleaseTag("hotfix-20260603-7-ab12cd3")).toBe("hotfix");
  });

  it("classifies SkillBrew staging tag variants as stage", () => {
    expect(classifyReleaseTag("stg")).toBe("stage");
    expect(classifyReleaseTag("staging")).toBe("stage");
    expect(classifyReleaseTag("stg-20260603-18-abc1234")).toBe("stage");
    expect(classifyReleaseTag("staging-20260603-18-abc1234")).toBe("stage");
  });

  it("classifies preprod tag variants as preprod", () => {
    expect(classifyReleaseTag("preprod")).toBe("preprod");
    expect(classifyReleaseTag("pre-prod")).toBe("preprod");
    expect(classifyReleaseTag("preprod-20260101-1-abc")).toBe("preprod");
    expect(classifyReleaseTag("pre-prod-20260101-1-abc")).toBe("preprod");
  });

  it("collects the environment pointer tags configured for a service", () => {
    const service: DeploymentService = {
      serviceId: "admin_app",
      name: "Admin App",
      githubRepository: "Brudite-Pvt-Ltd/TODO-admin_app",
      ecrRepository: "skillbrew-fe-admin",
      containerName: "admin_app",
      environments: {
        dev: {
          clusterName: "skillbrew-dev-cluster",
          serviceName: "admin_app",
          taskFamily: "skillbrew-dev-admin_app",
          environmentTag: "dev"
        },
        stage: {
          clusterName: "skillbrew-staging-cluster",
          serviceName: "admin_app",
          taskFamily: "skillbrew-staging-admin_app",
          environmentTag: "staging"
        },
        preprod: {
          clusterName: "skillbrew-staging-cluster",
          serviceName: "admin_app",
          taskFamily: "skillbrew-staging-admin_app",
          environmentTag: "preprod"
        },
        prod: {
          clusterName: "skillbrew-prod-cluster",
          serviceName: "admin_app",
          taskFamily: "skillbrew-prod-admin_app",
          environmentTag: "prod"
        }
      },
      allowedDeployRolesByEnvironment: {
        dev: ["admin", "user"],
        stage: ["admin", "user"],
        preprod: ["admin"],
        prod: ["admin"]
      }
    };

    expect(environmentPointerTags(service)).toEqual(new Set(["dev", "staging", "preprod", "prod"]));
  });

  it("ignores unconfigured environments when collecting pointer tags", () => {
    const service: DeploymentService = {
      serviceId: "sample-service",
      name: "Sample Service",
      githubRepository: "Naman-cell/Deploy2Dev",
      ecrRepository: "deploy2dev/sample-service",
      containerName: "app",
      environments: {
        dev: {
          clusterName: "deploy2dev-dev",
          serviceName: "sample-service-dev",
          taskFamily: "deploy2dev-sample-service-dev",
          environmentTag: "dev"
        }
      },
      allowedDeployRolesByEnvironment: {
        dev: ["admin", "user"]
      }
    };

    expect(environmentPointerTags(service)).toEqual(new Set(["dev"]));
  });
});
