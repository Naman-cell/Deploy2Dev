import serverless from "serverless-http";
import type { Handler } from "aws-lambda";
import { createApp } from "./app";
import { bootstrap } from "./bootstrap";

let cachedHandler: Handler | undefined;

export const handler: Handler = async (event, context, callback) => {
  if (!cachedHandler) {
    const bootstrapped = await bootstrap();
    const app = createApp(
      bootstrapped.config,
      bootstrapped.store,
      bootstrapped.deploymentCenter,
      bootstrapped.logger
    );
    cachedHandler = serverless(app);
  }

  return cachedHandler(event, context, callback);
};
