import type { AppConfig } from "../config";
import { AwsEcsAdapter, AwsRegistryAdapter } from "./aws-adapters";
import { MockEcsAdapter, MockRegistryAdapter } from "./mock-adapters";
import type { CloudAdapters } from "./types";

export function createCloudAdapters(config: AppConfig): CloudAdapters {
  if (config.awsIntegration === "aws") {
    return {
      registry: new AwsRegistryAdapter(config),
      ecs: new AwsEcsAdapter(config)
    };
  }

  return {
    registry: new MockRegistryAdapter(),
    ecs: new MockEcsAdapter()
  };
}
