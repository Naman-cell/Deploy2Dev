import { createApp } from "./app";
import { bootstrap } from "./bootstrap";

const { config, store, deploymentCenter, logger, trigger } = await bootstrap();
const app = createApp(config, store, deploymentCenter, logger, trigger);

app.listen(config.port, () => {
  logger.info("api listening", {
    port: config.port,
    dataStore: config.dataStore,
    awsIntegration: config.awsIntegration,
    seedAdminEmail: config.seedAdminEmail
  });
});
