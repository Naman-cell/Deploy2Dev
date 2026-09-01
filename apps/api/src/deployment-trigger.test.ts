import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-lambda", () => {
  class LambdaClient {
    public send = sendMock;
  }
  class InvokeCommand {
    public constructor(public readonly input: unknown) {}
  }
  return { LambdaClient, InvokeCommand };
});

import { InProcessDeploymentTrigger, LambdaDeploymentTrigger } from "./deployment-trigger";
import type { DeploymentCenterService } from "./deployment-service";
import type { Logger } from "./logger";

function createLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

beforeEach(() => {
  sendMock.mockReset();
});

describe("InProcessDeploymentTrigger", () => {
  it("fires executeDeployment in the background and resolves immediately", async () => {
    let resolveExecute!: () => void;
    const executeDeployment = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveExecute = resolve;
        })
    );
    const deploymentCenter = { executeDeployment } as unknown as DeploymentCenterService;
    const logger = createLogger();
    const trigger = new InProcessDeploymentTrigger(deploymentCenter, logger);

    await trigger.trigger("execute-deployment", "dep-1");

    expect(executeDeployment).toHaveBeenCalledWith("dep-1");
    resolveExecute();
  });

  it("resolves even if executeDeployment rejects, and logs the failure", async () => {
    const executeDeployment = vi.fn().mockRejectedValue(new Error("boom"));
    const deploymentCenter = { executeDeployment } as unknown as DeploymentCenterService;
    const logger = createLogger();
    const trigger = new InProcessDeploymentTrigger(deploymentCenter, logger);

    await expect(trigger.trigger("execute-deployment", "dep-2")).resolves.toBeUndefined();

    // Let the background .catch() run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logger.error).toHaveBeenCalledWith(
      "background deployment failed",
      expect.objectContaining({ action: "execute-deployment", deploymentId: "dep-2", error: "boom" })
    );
  });

  it("routes execute-rollback to executeRollback in the background", async () => {
    let resolveExecute!: () => void;
    const executeRollback = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveExecute = resolve;
        })
    );
    const deploymentCenter = { executeRollback } as unknown as DeploymentCenterService;
    const logger = createLogger();
    const trigger = new InProcessDeploymentTrigger(deploymentCenter, logger);

    await trigger.trigger("execute-rollback", "dep-rollback-1");

    expect(executeRollback).toHaveBeenCalledWith("dep-rollback-1");
    resolveExecute();
  });
});

describe("LambdaDeploymentTrigger", () => {
  it("invokes the configured function asynchronously with the deployment payload", async () => {
    sendMock.mockResolvedValue({});
    const logger = createLogger();
    const trigger = new LambdaDeploymentTrigger("heimdall-api", "ap-south-1", logger);

    await trigger.trigger("execute-deployment", "dep-3");

    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0]?.[0] as { input: Record<string, unknown> } | undefined;
    if (!call) {
      throw new Error("expected LambdaClient.send to have been called");
    }
    const command = call;
    expect(command.input).toMatchObject({
      FunctionName: "heimdall-api",
      InvocationType: "Event"
    });
    const payload = JSON.parse((command.input.Payload as Buffer).toString());
    expect(payload).toEqual({ action: "execute-deployment", deploymentId: "dep-3" });
  });

  it("invokes the configured function asynchronously with the rollback payload", async () => {
    sendMock.mockResolvedValue({});
    const logger = createLogger();
    const trigger = new LambdaDeploymentTrigger("heimdall-api", "ap-south-1", logger);

    await trigger.trigger("execute-rollback", "dep-4");

    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0]?.[0] as { input: Record<string, unknown> } | undefined;
    if (!call) {
      throw new Error("expected LambdaClient.send to have been called");
    }
    const payload = JSON.parse((call.input.Payload as Buffer).toString());
    expect(payload).toEqual({ action: "execute-rollback", deploymentId: "dep-4" });
  });
});
