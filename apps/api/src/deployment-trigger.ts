import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { DeploymentCenterService } from "./deployment-service";
import type { Logger } from "./logger";

export type DeploymentAction = "execute-deployment" | "execute-rollback";

export interface DeploymentTrigger {
  trigger(action: DeploymentAction, deploymentId: string): Promise<void>;
}

// Non-Lambda runtime (local dev server, tests): just kick off `executeDeployment` in the
// background on the same process. Errors are swallowed here (and logged) rather than propagated,
// since the caller has already responded 202 to the client by the time this settles.
export class InProcessDeploymentTrigger implements DeploymentTrigger {
  public constructor(
    private readonly deploymentCenter: DeploymentCenterService,
    private readonly logger: Logger
  ) {}

  public trigger(action: DeploymentAction, deploymentId: string): Promise<void> {
    const run =
      action === "execute-deployment"
        ? this.deploymentCenter.executeDeployment(deploymentId)
        : this.deploymentCenter.executeRollback(deploymentId);
    void run.catch((err) => {
      this.logger.error("background deployment failed", {
        action,
        deploymentId,
        error: err instanceof Error ? err.message : String(err)
      });
    });
    return Promise.resolve();
  }
}

// Lambda runtime: self-invoke asynchronously (InvocationType "Event") so the rollout runs in a
// fresh, untimed invocation instead of blocking the API Gateway request/response cycle.
export class LambdaDeploymentTrigger implements DeploymentTrigger {
  private readonly client: LambdaClient;

  public constructor(
    private readonly functionName: string,
    region: string,
    private readonly logger: Logger
  ) {
    this.client = new LambdaClient({ region });
  }

  public async trigger(action: DeploymentAction, deploymentId: string): Promise<void> {
    this.logger.info("triggering async deployment worker", {
      action,
      deploymentId,
      functionName: this.functionName
    });
    await this.client.send(
      new InvokeCommand({
        FunctionName: this.functionName,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ action, deploymentId }))
      })
    );
  }
}
