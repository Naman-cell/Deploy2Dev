import type { AppConfig } from "../config";
import type { Logger } from "../logger";
import { AwsEcsAdapter, AwsRegistryAdapter } from "./aws-adapters";
import { MockGitHubAdapter, RealGitHubAdapter } from "./github";
import { MockEcsAdapter, MockRegistryAdapter } from "./mock-adapters";
import type { CloudAdapters } from "./types";

export function createCloudAdapters(config: AppConfig, logger: Logger): CloudAdapters {
  if (config.awsIntegration === "aws") {
    return {
      registry: new AwsRegistryAdapter(config, logger),
      ecs: new AwsEcsAdapter(config),
      github: new RealGitHubAdapter(config.githubToken)
    };
  }

  return {
    registry: new MockRegistryAdapter(),
    ecs: new MockEcsAdapter(),
    github: config.githubToken
      ? new RealGitHubAdapter(config.githubToken)
      : new MockGitHubAdapter()
  };
}
