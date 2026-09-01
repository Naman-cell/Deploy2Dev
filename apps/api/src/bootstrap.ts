import { loadConfig } from "./config";
import { DeploymentCenterService } from "./deployment-service";
import { InProcessDeploymentTrigger, LambdaDeploymentTrigger } from "./deployment-trigger";
import { createCloudAdapters } from "./integrations";
import { logger } from "./logger";
import { createStore } from "./store";

export async function bootstrap() {
  const config = loadConfig();
  const store = createStore(config);
  await store.ensureSeedAdmin();
  const cloud = createCloudAdapters(config, logger);
  const deploymentCenter = new DeploymentCenterService(config, store, cloud, logger);

  const trigger =
    config.awsIntegration === "aws" && process.env.AWS_LAMBDA_FUNCTION_NAME
      ? new LambdaDeploymentTrigger(process.env.AWS_LAMBDA_FUNCTION_NAME, config.awsRegion, logger)
      : new InProcessDeploymentTrigger(deploymentCenter, logger);

  return { config, store, cloud, deploymentCenter, trigger, logger };
}
