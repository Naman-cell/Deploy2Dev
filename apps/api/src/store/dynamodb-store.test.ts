import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import type { Deployment } from "@heimdall/shared";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config";
import { documentClientTranslateConfig, DynamoDbStore } from "./dynamodb-store";

// Minimally valid Deployment: only the required fields from the shared schema are set.
// The optional fields (previousEnvironmentImageDigest, previousTaskDefinitionArn,
// newTaskDefinitionArn, completedAt, errorMessage) are explicitly present with value
// `undefined` — NOT simply omitted. This distinction matters: `marshall()` only throws
// when a key is present with an `undefined` value; an absent key is fine. This is exactly
// what happens in DeploymentCenterService.deploy() (apps/api/src/deployment-service.ts):
// `deployment.previousEnvironmentImageDigest = previousState.environmentImageDigest` and
// `deployment.previousTaskDefinitionArn = previousState.currentTaskDefinitionArn` assign
// straight from `CurrentServiceState`'s optional fields, which are `undefined` for a
// service/environment with no prior deployment — explicitly writing `undefined` keys onto
// the deployment object before it's persisted via `store.updateDeployment()`. That is the
// real trigger of the production 500: "Pass options.removeUndefinedValues=true to remove
// undefined values from map/array/set."
function buildFreshDeployment(): Deployment {
  return {
    deploymentId: "dep-1",
    serviceId: "sample-service",
    serviceName: "Sample Service",
    environment: "dev",
    requestedBy: "Jane Doe",
    requestedByEmail: "jane@example.com",
    selectedImageTag: "v1.2.3",
    selectedImageDigest: "sha256:abc123",
    previousEnvironmentImageDigest: undefined,
    previousTaskDefinitionArn: undefined,
    newTaskDefinitionArn: undefined,
    status: "pending",
    startedAt: new Date().toISOString(),
    completedAt: undefined,
    errorMessage: undefined,
    correlationId: "corr-1",
    events: []
  };
}

describe("DynamoDbStore.saveDeployment", () => {
  const dynamoDbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(() => {
    dynamoDbMock.reset();
    process.env.SERVICE_CATALOG = "sandbox";
    process.env.DATA_STORE = "dynamodb";
    process.env.SEED_ADMIN_PASSWORD = "local-development-admin-password";
  });

  afterEach(() => {
    delete process.env.SERVICE_CATALOG;
    delete process.env.DATA_STORE;
    delete process.env.SEED_ADMIN_PASSWORD;
  });

  // NOTE: aws-sdk-client-mock intercepts at the client `send()` level, which runs
  // *before* the DocumentClient's marshalling middleware. Verified empirically: sending a
  // PutCommand with an `undefined` field through a mocked DynamoDBDocumentClient resolves
  // identically whether `removeUndefinedValues` is true or false. This test therefore only
  // proves the store is wired correctly (correct TableName/Item, resolves without
  // throwing) — it is NOT a regression guard for the marshalling bug itself. See the
  // "marshalling regression guard" suite below for that.
  it("issues a PutCommand with the expected TableName and Item, and resolves without throwing", async () => {
    dynamoDbMock.on(PutCommand).resolves({});

    const config = loadConfig();
    const store = new DynamoDbStore(config);
    const deployment = buildFreshDeployment();

    await expect(store.saveDeployment(deployment)).resolves.toBeUndefined();

    const calls = dynamoDbMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]?.input).toEqual({
      TableName: config.deploymentsTableName,
      Item: deployment
    });
  });
});

describe("marshalling regression guard (real @aws-sdk/util-dynamodb marshall)", () => {
  // This exercises the exact translateConfig the store passes to
  // `DynamoDBDocumentClient.from()` (imported, not duplicated), so if dynamodb-store.ts is
  // reverted to construct the client without marshallOptions, either:
  //   (a) `documentClientTranslateConfig` no longer exists and this file fails to
  //       import/compile, or
  //   (b) the exported config still doesn't match what `marshall()` actually needs and the
  //       assertion below fails.
  // Either way this test cannot pass against the buggy version of the store.
  it("marshals a fresh deployment's undefined optional fields without throwing using the store's configured marshallOptions", () => {
    const deployment = buildFreshDeployment();

    expect(() => marshall(deployment, documentClientTranslateConfig.marshallOptions)).not.toThrow();
  });

  // Documents the underlying bug directly: without removeUndefinedValues, marshalling an
  // object containing `undefined` values throws the exact error observed in CloudWatch.
  it("throws the production error when marshalling without removeUndefinedValues", () => {
    const deployment = buildFreshDeployment();

    expect(() => marshall(deployment)).toThrow(
      "Pass options.removeUndefinedValues=true to remove undefined values from map/array/set."
    );
  });
});

describe("DocumentClient wiring", () => {
  // Neither of the two suites above actually proves the store *wires* the fix in: the first
  // mocks at the `send()` level (below the marshalling middleware) and the second exercises
  // `documentClientTranslateConfig` in isolation via a hand-called `marshall()`. If
  // dynamodb-store.ts were reverted to `DynamoDBDocumentClient.from(client)` (dropping the
  // second arg) while leaving the `documentClientTranslateConfig` export in place, both
  // suites above would still pass. This suite spies on `DynamoDBDocumentClient.from` itself
  // to assert the store actually passes `removeUndefinedValues: true` into the real
  // constructor call — the actual regression.
  beforeEach(() => {
    process.env.SERVICE_CATALOG = "sandbox";
    process.env.DATA_STORE = "dynamodb";
    process.env.SEED_ADMIN_PASSWORD = "local-development-admin-password";
  });

  afterEach(() => {
    delete process.env.SERVICE_CATALOG;
    delete process.env.DATA_STORE;
    delete process.env.SEED_ADMIN_PASSWORD;
    vi.restoreAllMocks();
  });

  it("constructs the DocumentClient with removeUndefinedValues=true", () => {
    const fromSpy = vi.spyOn(DynamoDBDocumentClient, "from");

    new DynamoDbStore(loadConfig());

    expect(fromSpy).toHaveBeenCalledTimes(1);
    expect(fromSpy.mock.calls[0]?.[1]?.marshallOptions?.removeUndefinedValues).toBe(true);
  });
});
