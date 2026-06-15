import { loadConfig } from "./config";
import { DeploymentCenterService } from "./deployment-service";
import { createCloudAdapters } from "./integrations";
import { logger } from "./logger";
import { createStore } from "./store";

export async function bootstrap() {
  const config = loadConfig();
  const store = createStore(config);
  await store.ensureSeedAdmin();
  const cloud = createCloudAdapters(config);
  const deploymentCenter = new DeploymentCenterService(config, store, cloud, logger);

  return { config, store, cloud, deploymentCenter, logger };
}
