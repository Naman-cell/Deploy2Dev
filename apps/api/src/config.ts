import type { DeploymentService } from "@heimdall/shared";

export interface AppConfig {
  port: number;
  jwtSecret: string;
  tokenTtlSeconds: number;
  dataStore: "memory" | "dynamodb";
  awsIntegration: "mock" | "aws";
  awsRegion: string;
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
    prod: ["admin"]
  }
};

export function loadConfig(): AppConfig {
  const dataStore = process.env.DATA_STORE === "dynamodb" ? "dynamodb" : "memory";

  return {
    port: Number(process.env.PORT ?? "4000"),
    jwtSecret: readRequired("JWT_SECRET", "local-development-secret-change-me"),
    tokenTtlSeconds: Number(process.env.TOKEN_TTL_SECONDS ?? "28800"),
    dataStore,
    awsIntegration: process.env.AWS_INTEGRATION === "aws" ? "aws" : "mock",
    awsRegion: process.env.AWS_REGION ?? "us-east-1",
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
    services: [sandboxService]
  };
}
