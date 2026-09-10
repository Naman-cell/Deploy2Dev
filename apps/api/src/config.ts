import { ServiceSchema, type DeploymentService } from "@heimdall/shared";
import { readFileSync } from "node:fs";
import { z } from "zod";
import bundledServiceCatalog from "./service-catalog.json" with { type: "json" };

export interface AppConfig {
  port: number;
  jwtSecret: string;
  tokenTtlSeconds: number;
  dataStore: "memory" | "dynamodb";
  awsIntegration: "mock" | "aws";
  awsRegion: string;
  /** Total budget (ms) for `EcsAdapter.waitForStable` to poll before throwing `ecs_not_stable`.
   * Default 10 minutes — long enough to tolerate a cold ECR image pull on a fresh instance, which
   * can take several minutes and previously false-failed against the SDK waiter's 300s ceiling. */
  stabilityTimeoutMs: number;
  /** Delay (ms) between `DescribeServices` polls in `EcsAdapter.waitForStable`. */
  stabilityPollDelayMs: number;
  usersTableName: string;
  deploymentsTableName: string;
  deploymentEventsTableName: string;
  locksTableName: string;
  seedAdminEmail: string;
  seedAdminPassword: string;
  services: DeploymentService[];
}

function readRequired(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required config: ${name}`);
  }
  return value;
}

const sandboxService: DeploymentService = {
  serviceId: "sample-service",
  name: "Sample Service",
  githubRepository: "Naman-cell/Deploy2Dev",
  ecrRepository: "deploy2dev/sample-service",
  ecrRepositoryUri: process.env.ECR_REPOSITORY_URI ?? "deploy2dev/sample-service",
  containerName: process.env.ECS_CONTAINER_NAME ?? "app",
  environments: {
    dev: {
      clusterName: process.env.ECS_CLUSTER_NAME ?? "deploy2dev-dev",
      serviceName: process.env.ECS_SERVICE_NAME ?? "sample-service-dev",
      taskFamily: process.env.ECS_TASK_FAMILY ?? "deploy2dev-sample-service-dev",
      environmentTag: "dev"
    },
    stage: {
      clusterName: process.env.ECS_STAGE_CLUSTER_NAME ?? "deploy2dev-dev",
      serviceName: process.env.ECS_STAGE_SERVICE_NAME ?? "sample-service-stage",
      taskFamily: process.env.ECS_STAGE_TASK_FAMILY ?? "deploy2dev-sample-service-stage",
      environmentTag: "stage"
    },
    preprod: {
      clusterName:
        process.env.ECS_PREPROD_CLUSTER_NAME ?? process.env.ECS_STAGE_CLUSTER_NAME ?? "deploy2dev-dev",
      serviceName:
        process.env.ECS_PREPROD_SERVICE_NAME ?? process.env.ECS_STAGE_SERVICE_NAME ?? "sample-service-stage",
      taskFamily:
        process.env.ECS_PREPROD_TASK_FAMILY ??
        process.env.ECS_STAGE_TASK_FAMILY ??
        "deploy2dev-sample-service-stage",
      environmentTag: "preprod"
    },
    prod: {
      clusterName: process.env.ECS_PROD_CLUSTER_NAME ?? "deploy2dev-dev",
      serviceName: process.env.ECS_PROD_SERVICE_NAME ?? "sample-service-prod",
      taskFamily: process.env.ECS_PROD_TASK_FAMILY ?? "deploy2dev-sample-service-prod",
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

const ServiceCatalogSchema = z
  .array(ServiceSchema)
  .min(1, "Service catalog must contain at least one service")
  .refine(
    (services) => services.every((service) => Object.keys(service.environments).length > 0),
    (services) => {
      const unconfigured = services.find((service) => Object.keys(service.environments).length === 0);
      return {
        message: `Service "${unconfigured?.serviceId ?? "<unknown>"}" has no configured environments`
      };
    }
  );

function parseServiceCatalog(source: string, raw: unknown): DeploymentService[] {
  const result = ServiceCatalogSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid service catalog from ${source}: ${result.error.message}`);
  }
  return result.data;
}

function loadServiceCatalog(): DeploymentService[] {
  const inlineJson = process.env.SERVICE_CATALOG_JSON;
  if (inlineJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(inlineJson);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid service catalog from SERVICE_CATALOG_JSON: not valid JSON (${message})`);
    }
    return parseServiceCatalog("SERVICE_CATALOG_JSON", parsed);
  }

  const catalogPath = process.env.SERVICE_CATALOG_PATH;
  if (catalogPath) {
    let contents: string;
    try {
      contents = readFileSync(catalogPath, "utf-8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid service catalog from SERVICE_CATALOG_PATH=${catalogPath}: ${message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Invalid service catalog from SERVICE_CATALOG_PATH=${catalogPath}: not valid JSON (${message})`
      );
    }
    return parseServiceCatalog(`SERVICE_CATALOG_PATH=${catalogPath}`, parsed);
  }

  if (process.env.SERVICE_CATALOG === "sandbox") {
    return parseServiceCatalog("SERVICE_CATALOG=sandbox", [sandboxService]);
  }

  return parseServiceCatalog("bundled service-catalog.json", bundledServiceCatalog);
}

export function loadConfig(): AppConfig {
  const dataStore = process.env.DATA_STORE === "dynamodb" ? "dynamodb" : "memory";

  return {
    port: Number(process.env.PORT ?? "4000"),
    jwtSecret: readRequired("JWT_SECRET", "local-development-secret-change-me"),
    tokenTtlSeconds: Number(process.env.TOKEN_TTL_SECONDS ?? "28800"),
    dataStore,
    awsIntegration: process.env.AWS_INTEGRATION === "aws" ? "aws" : "mock",
    awsRegion: process.env.AWS_REGION ?? "ap-south-1",
    stabilityTimeoutMs: Number(process.env.STABILITY_TIMEOUT_MS ?? "600000"),
    stabilityPollDelayMs: Number(process.env.STABILITY_POLL_DELAY_MS ?? "10000"),
    usersTableName: process.env.USERS_TABLE_NAME ?? "heimdall-users",
    deploymentsTableName: process.env.DEPLOYMENTS_TABLE_NAME ?? "heimdall-deployments",
    deploymentEventsTableName:
      process.env.DEPLOYMENT_EVENTS_TABLE_NAME ?? "heimdall-deployment-events",
    locksTableName: process.env.LOCKS_TABLE_NAME ?? "heimdall-locks",
    seedAdminEmail: process.env.SEED_ADMIN_EMAIL ?? "admin@example.com",
    seedAdminPassword:
      process.env.SEED_ADMIN_PASSWORD ??
      (dataStore === "memory"
        ? "local-development-admin-password"
        : readRequired("SEED_ADMIN_PASSWORD")),
    services: loadServiceCatalog()
  };
}
