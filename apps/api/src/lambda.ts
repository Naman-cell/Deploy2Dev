import serverless from "serverless-http";
import type { Handler } from "aws-lambda";
import { createApp } from "./app";
import { bootstrap } from "./bootstrap";

let cached: { handler: Handler; bootstrapped: Awaited<ReturnType<typeof bootstrap>> } | undefined;

async function getCached() {
  if (!cached) {
    const bootstrapped = await bootstrap();
    const app = createApp(
      bootstrapped.config,
      bootstrapped.store,
      bootstrapped.deploymentCenter,
      bootstrapped.logger,
      bootstrapped.trigger
    );
    cached = { handler: serverless(app), bootstrapped };
  }
  return cached;
}

interface WorkerEvent {
  action: "execute-deployment" | "execute-rollback";
  deploymentId: string;
}

function isWorkerEvent(event: unknown): event is WorkerEvent {
  const action = (event as { action?: unknown } | null)?.action;
  return (
    typeof event === "object" &&
    event !== null &&
    (action === "execute-deployment" || action === "execute-rollback") &&
    typeof (event as { deploymentId?: unknown }).deploymentId === "string"
  );
}

// API-Gateway proxy events never carry an `action` field, so they fall through to the express
// handler as before. Async self-invocations from `LambdaDeploymentTrigger` carry
// `{ action: "execute-deployment" | "execute-rollback", deploymentId }` and are routed to the
// long-running ECS worker path instead, which is not subject to the API Gateway request timeout.
export const handler: Handler = async (event, context, callback) => {
  const { handler: httpHandler, bootstrapped } = await getCached();

  if (isWorkerEvent(event)) {
    if (event.action === "execute-deployment") {
      await bootstrapped.deploymentCenter.executeDeployment(event.deploymentId);
    } else {
      await bootstrapped.deploymentCenter.executeRollback(event.deploymentId);
    }
    return { ok: true };
  }

  return httpHandler(event, context, callback);
};
