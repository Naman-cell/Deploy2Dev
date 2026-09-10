import { BatchGetImageCommand, DescribeImagesCommand, PutImageCommand } from "@aws-sdk/client-ecr";
import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand
} from "@aws-sdk/client-ecs";
import type { DeploymentService, Environment } from "@heimdall/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../config";
import { loadConfig } from "../config";
import type { Logger } from "../logger";
import { logger } from "../logger";
import { AwsEcsAdapter, AwsRegistryAdapter } from "./aws-adapters";
import type { StabilityProgress } from "./types";

// loadServiceCatalog (config.ts) checks SERVICE_CATALOG_JSON and SERVICE_CATALOG_PATH before
// SERVICE_CATALOG, so all three must be controlled here or a value left over from the host
// environment (or another test file) silently changes which catalog these tests load.
const CATALOG_ENV_VARS = [
  "SERVICE_CATALOG",
  "SERVICE_CATALOG_JSON",
  "SERVICE_CATALOG_PATH"
] as const;
const ORIGINAL_CATALOG_ENV: Record<(typeof CATALOG_ENV_VARS)[number], string | undefined> = {
  SERVICE_CATALOG: process.env.SERVICE_CATALOG,
  SERVICE_CATALOG_JSON: process.env.SERVICE_CATALOG_JSON,
  SERVICE_CATALOG_PATH: process.env.SERVICE_CATALOG_PATH
};

afterEach(() => {
  for (const name of CATALOG_ENV_VARS) {
    const original = ORIGINAL_CATALOG_ENV[name];
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }
});

/** Loads the bundled SkillBrew catalog the same way the sandbox/skillbrew harness in
 * deployment-service.test.ts does: none of the three catalog env vars set. */
function loadSkillBrewConfig(): AppConfig {
  for (const name of CATALOG_ENV_VARS) {
    delete process.env[name];
  }
  return loadConfig();
}

function getSkillBrewService(serviceId: string): { config: AppConfig; service: DeploymentService } {
  const config = loadSkillBrewConfig();
  const service = config.services.find((candidate) => candidate.serviceId === serviceId);
  if (!service) {
    throw new Error(
      `Fixture service "${serviceId}" was not found in the bundled SkillBrew catalog`
    );
  }
  return { config, service };
}

interface StubbableAdapter {
  client: { send: (command: unknown) => Promise<unknown> };
}

/**
 * Replaces `send` on the adapter's own (real) ECRClient/ECSClient instance, per the AWS SDK v3
 * pagination trap: `@smithy/core`'s `createPaginator` does `config.client instanceof ClientCtor`,
 * so a plain-object fake client throws wherever `listReleases`'s paginator is involved. Using the
 * adapter's real client and only swapping its `send` method keeps that instanceof check happy.
 */
function stubSend(adapter: object, impl: (command: unknown) => Promise<unknown>): void {
  (adapter as unknown as StubbableAdapter).client.send = impl;
}

function collectingLogger(
  sink: Array<{ message: string; metadata?: Record<string, unknown> }>
): Logger {
  return {
    info: () => {},
    warn: (message, metadata) => sink.push({ message, metadata }),
    error: () => {}
  };
}

describe("AwsRegistryAdapter", () => {
  describe("promoteEnvironmentTag", () => {
    it("writes the wire tag stg (not stage) when promoting django_app to stage", async () => {
      const { config, service } = getSkillBrewService("django_app");
      const adapter = new AwsRegistryAdapter(config, logger);
      const calls: unknown[] = [];

      stubSend(adapter, async (command) => {
        calls.push(command);
        if (command instanceof BatchGetImageCommand) {
          return { images: [{ imageManifest: "manifest-blob" }] };
        }
        if (command instanceof PutImageCommand) {
          return {};
        }
        throw new Error("unexpected command sent to stub");
      });

      await adapter.promoteEnvironmentTag(service, "stage", "sha256:deadbeef");

      const putCall = calls.find(
        (call): call is PutImageCommand => call instanceof PutImageCommand
      );
      expect(putCall).toBeDefined();
      expect(putCall?.input.imageTag).toBe("stg");
      expect(putCall?.input.imageTag).not.toBe("stage");
      expect(putCall?.input.repositoryName).toBe("skillbrew-be");
    });

    it("writes the wire tag staging (not stg) when promoting admin_app to stage", async () => {
      const { config, service } = getSkillBrewService("admin_app");
      const adapter = new AwsRegistryAdapter(config, logger);
      const calls: unknown[] = [];

      stubSend(adapter, async (command) => {
        calls.push(command);
        if (command instanceof BatchGetImageCommand) {
          return { images: [{ imageManifest: "manifest-blob" }] };
        }
        if (command instanceof PutImageCommand) {
          return {};
        }
        throw new Error("unexpected command sent to stub");
      });

      await adapter.promoteEnvironmentTag(service, "stage", "sha256:deadbeef");

      const putCall = calls.find(
        (call): call is PutImageCommand => call instanceof PutImageCommand
      );
      expect(putCall?.input.imageTag).toBe("staging");
      expect(putCall?.input.imageTag).not.toBe("stg");
      expect(putCall?.input.repositoryName).toBe("skillbrew-fe-admin");
    });

    it("round-trips dev to dev and prod to prod", async () => {
      const { config, service } = getSkillBrewService("django_app");
      const adapter = new AwsRegistryAdapter(config, logger);

      for (const [environment, expectedTag] of [
        ["dev", "dev"],
        ["prod", "prod"]
      ] as const satisfies ReadonlyArray<readonly [Environment, string]>) {
        const calls: unknown[] = [];
        stubSend(adapter, async (command) => {
          calls.push(command);
          if (command instanceof BatchGetImageCommand) {
            return { images: [{ imageManifest: "manifest-blob" }] };
          }
          if (command instanceof PutImageCommand) {
            return {};
          }
          throw new Error("unexpected command sent to stub");
        });

        await adapter.promoteEnvironmentTag(service, environment, "sha256:deadbeef");

        const putCall = calls.find(
          (call): call is PutImageCommand => call instanceof PutImageCommand
        );
        expect(putCall?.input.imageTag).toBe(expectedTag);
      }
    });

    it("writes the wire tag preprod when promoting django_app to preprod, into the same repository as stage", async () => {
      const { config, service } = getSkillBrewService("django_app");
      const adapter = new AwsRegistryAdapter(config, logger);
      const calls: unknown[] = [];

      stubSend(adapter, async (command) => {
        calls.push(command);
        if (command instanceof BatchGetImageCommand) {
          return { images: [{ imageManifest: "manifest-blob" }] };
        }
        if (command instanceof PutImageCommand) {
          return {};
        }
        throw new Error("unexpected command sent to stub");
      });

      await adapter.promoteEnvironmentTag(service, "preprod", "sha256:deadbeef");

      const putCall = calls.find(
        (call): call is PutImageCommand => call instanceof PutImageCommand
      );
      expect(putCall).toBeDefined();
      expect(putCall?.input.imageTag).toBe("preprod");
      expect(putCall?.input.repositoryName).toBe("skillbrew-be");
    });
  });

  describe("getEnvironmentDigest", () => {
    it("requests DescribeImages using the wire tag stg for stage", async () => {
      const { config, service } = getSkillBrewService("django_app");
      const adapter = new AwsRegistryAdapter(config, logger);
      let captured: DescribeImagesCommand | undefined;

      stubSend(adapter, async (command) => {
        if (command instanceof DescribeImagesCommand) {
          captured = command;
          return { imageDetails: [{ imageDigest: "sha256:current" }] };
        }
        throw new Error("unexpected command sent to stub");
      });

      const digest = await adapter.getEnvironmentDigest(service, "stage");

      expect(digest).toBe("sha256:current");
      expect(captured?.input.imageIds?.[0]?.imageTag).toBe("stg");
    });

    it("round-trips dev to dev and prod to prod", async () => {
      const { config, service } = getSkillBrewService("django_app");
      const adapter = new AwsRegistryAdapter(config, logger);

      for (const [environment, expectedTag] of [
        ["dev", "dev"],
        ["prod", "prod"]
      ] as const satisfies ReadonlyArray<readonly [Environment, string]>) {
        let captured: DescribeImagesCommand | undefined;
        stubSend(adapter, async (command) => {
          if (command instanceof DescribeImagesCommand) {
            captured = command;
            return { imageDetails: [{ imageDigest: "sha256:current" }] };
          }
          throw new Error("unexpected command sent to stub");
        });

        await adapter.getEnvironmentDigest(service, environment);

        expect(captured?.input.imageIds?.[0]?.imageTag).toBe(expectedTag);
      }
    });

    it("requests DescribeImages using the wire tag preprod for preprod", async () => {
      const { config, service } = getSkillBrewService("django_app");
      const adapter = new AwsRegistryAdapter(config, logger);
      let captured: DescribeImagesCommand | undefined;

      stubSend(adapter, async (command) => {
        if (command instanceof DescribeImagesCommand) {
          captured = command;
          return { imageDetails: [{ imageDigest: "sha256:current" }] };
        }
        throw new Error("unexpected command sent to stub");
      });

      const digest = await adapter.getEnvironmentDigest(service, "preprod");

      expect(digest).toBe("sha256:current");
      expect(captured?.input.imageIds?.[0]?.imageTag).toBe("preprod");
    });
  });

  describe("findRelease", () => {
    it("returns undefined when the digest exists but is not tagged with the requested tag", async () => {
      const { config, service } = getSkillBrewService("django_app");
      const adapter = new AwsRegistryAdapter(config, logger);

      stubSend(adapter, async (command) => {
        if (command instanceof DescribeImagesCommand) {
          return {
            imageDetails: [{ imageDigest: "sha256:current", imageTags: ["some-other-tag"] }]
          };
        }
        throw new Error("unexpected command sent to stub");
      });

      await expect(
        adapter.findRelease(service, "dev-20260603-1-abc1234", "sha256:current")
      ).resolves.toBeUndefined();
    });

    it("returns undefined on ImageNotFoundException", async () => {
      const { config, service } = getSkillBrewService("django_app");
      const adapter = new AwsRegistryAdapter(config, logger);

      stubSend(adapter, async () => {
        const error = new Error("Image not found");
        error.name = "ImageNotFoundException";
        throw error;
      });

      await expect(
        adapter.findRelease(service, "dev-20260603-1-abc1234", "sha256:current")
      ).resolves.toBeUndefined();
    });

    it("propagates errors other than ImageNotFoundException, e.g. AccessDeniedException", async () => {
      const { config, service } = getSkillBrewService("django_app");
      const adapter = new AwsRegistryAdapter(config, logger);

      stubSend(adapter, async () => {
        const error = new Error("User is not authorized to perform ecr:DescribeImages");
        error.name = "AccessDeniedException";
        throw error;
      });

      await expect(
        adapter.findRelease(service, "dev-20260603-1-abc1234", "sha256:current")
      ).rejects.toThrow("not authorized");
    });

    it("derives sourceBranch from a sibling branch-<branch>--<sha> tag on the same digest", async () => {
      const { config, service } = getSkillBrewService("django_app");
      const adapter = new AwsRegistryAdapter(config, logger);

      stubSend(adapter, async (command) => {
        if (command instanceof DescribeImagesCommand) {
          return {
            imageDetails: [
              {
                imageDigest: "sha256:current",
                imageTags: ["dev-20260603-1-abc1234", "branch-main--abc1234"]
              }
            ]
          };
        }
        throw new Error("unexpected command sent to stub");
      });

      await expect(
        adapter.findRelease(service, "dev-20260603-1-abc1234", "sha256:current")
      ).resolves.toMatchObject({ sourceBranch: "main" });
    });

    it("leaves sourceBranch undefined when no sibling tag matches the branch convention", async () => {
      const { config, service } = getSkillBrewService("django_app");
      const adapter = new AwsRegistryAdapter(config, logger);

      stubSend(adapter, async (command) => {
        if (command instanceof DescribeImagesCommand) {
          return {
            imageDetails: [
              { imageDigest: "sha256:current", imageTags: ["dev-20260603-1-abc1234"] }
            ]
          };
        }
        throw new Error("unexpected command sent to stub");
      });

      await expect(
        adapter.findRelease(service, "dev-20260603-1-abc1234", "sha256:current")
      ).resolves.toMatchObject({ sourceBranch: undefined });
    });
  });

  describe("listReleases", () => {
    it("spans multiple pages, sorts releases across pages, and preserves tagStatus TAGGED on every page", async () => {
      const { config, service } = getSkillBrewService("django_app");
      const adapter = new AwsRegistryAdapter(config, logger);

      const capturedFilters: unknown[] = [];
      const capturedTokens: Array<string | undefined> = [];
      let call = 0;

      stubSend(adapter, async (command) => {
        if (!(command instanceof DescribeImagesCommand)) {
          throw new Error("unexpected command sent to stub");
        }
        call += 1;
        // Snapshot the fields we care about now: @smithy/core's createPaginator mutates a single
        // shared input object across pages, so reading `command.input` off a captured command
        // *after* the loop finishes would show every entry with the final page's state.
        capturedFilters.push(command.input.filter);
        capturedTokens.push(command.input.nextToken);

        if (call === 1) {
          return {
            imageDetails: [
              {
                imageDigest: "sha256:aaa",
                imageTags: ["dev-20260101-1-aaaaaaa"],
                imagePushedAt: new Date("2026-01-01T00:00:00.000Z")
              }
            ],
            nextToken: "page-2"
          };
        }

        return {
          imageDetails: [
            {
              imageDigest: "sha256:bbb",
              imageTags: ["dev-20260201-2-bbbbbbb"],
              imagePushedAt: new Date("2026-02-01T00:00:00.000Z")
            }
          ]
        };
      });

      const releases = await adapter.listReleases(service);

      expect(releases.map((release) => release.tag)).toEqual([
        "dev-20260201-2-bbbbbbb",
        "dev-20260101-1-aaaaaaa"
      ]);
      expect(capturedFilters).toEqual([{ tagStatus: "TAGGED" }, { tagStatus: "TAGGED" }]);
      expect(capturedTokens).toEqual([undefined, "page-2"]);
    });

    it("populates sourceBranch on every per-tag Release pushed for a digest, derived from that digest's full tag set", async () => {
      const { config, service } = getSkillBrewService("django_app");
      const adapter = new AwsRegistryAdapter(config, logger);

      stubSend(adapter, async (command) => {
        if (!(command instanceof DescribeImagesCommand)) {
          throw new Error("unexpected command sent to stub");
        }
        return {
          imageDetails: [
            {
              imageDigest: "sha256:release-branch",
              // Double-dash form CI actually produces, alongside a plain sha- tag on the same digest.
              imageTags: ["sha-fa867dc", "branch-main--fa867dc"],
              imagePushedAt: new Date("2026-03-01T00:00:00.000Z")
            },
            {
              imageDigest: "sha256:no-branch",
              imageTags: ["dev-20260301-1-fa867de"],
              imagePushedAt: new Date("2026-02-01T00:00:00.000Z")
            }
          ]
        };
      });

      const releases = await adapter.listReleases(service);

      const releaseBranchTags = releases.filter((release) => release.digest === "sha256:release-branch");
      expect(releaseBranchTags).toHaveLength(2);
      expect(releaseBranchTags.every((release) => release.sourceBranch === "main")).toBe(true);

      const noBranchRelease = releases.find((release) => release.digest === "sha256:no-branch");
      expect(noBranchRelease?.sourceBranch).toBeUndefined();
    });

    it("terminates when ECR returns the same nextToken repeatedly", async () => {
      const { config, service } = getSkillBrewService("django_app");
      const adapter = new AwsRegistryAdapter(config, logger);
      let sendCalls = 0;

      stubSend(adapter, async (command) => {
        if (!(command instanceof DescribeImagesCommand)) {
          throw new Error("unexpected command sent to stub");
        }
        sendCalls += 1;
        return {
          imageDetails: [
            {
              imageDigest: `sha256:${sendCalls}`,
              imageTags: [`tag-${sendCalls}`],
              imagePushedAt: new Date()
            }
          ],
          nextToken: "same-token"
        };
      });

      await adapter.listReleases(service);

      expect(sendCalls).toBeLessThanOrEqual(2);
    });

    it("stops at a hard page cap and logs a warning if ECR keeps advancing the token forever", async () => {
      const { config, service } = getSkillBrewService("django_app");
      const warnings: Array<{ message: string; metadata?: Record<string, unknown> }> = [];
      const adapter = new AwsRegistryAdapter(config, collectingLogger(warnings));
      let sendCalls = 0;

      stubSend(adapter, async (command) => {
        if (!(command instanceof DescribeImagesCommand)) {
          throw new Error("unexpected command sent to stub");
        }
        sendCalls += 1;
        return {
          imageDetails: [
            {
              imageDigest: `sha256:${sendCalls}`,
              imageTags: [`tag-${sendCalls}`],
              imagePushedAt: new Date()
            }
          ],
          // A different token every time so stopOnSameToken never kicks in: this simulates a
          // pathological/unbounded pagination sequence and forces the hard page cap to trigger.
          nextToken: `token-${sendCalls}`
        };
      });

      const releases = await adapter.listReleases(service);

      expect(sendCalls).toBeLessThan(200);
      expect(releases).toHaveLength(sendCalls);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]?.message.toLowerCase()).toContain("page");
    });
  });
});

describe("AwsEcsAdapter", () => {
  function stubForceDeploy(
    adapter: AwsEcsAdapter,
    options: {
      containerDefinitions: Array<{ name: string; image: string }>;
    }
  ): unknown[] {
    const calls: unknown[] = [];
    const currentTaskDefinitionArn =
      "arn:aws:ecs:ap-south-1:741005527903:task-definition/current:1";
    const registeredTaskDefinitionArn =
      "arn:aws:ecs:ap-south-1:741005527903:task-definition/next:1";

    stubSend(adapter, async (command) => {
      calls.push(command);
      if (command instanceof DescribeServicesCommand) {
        return {
          services: [
            {
              taskDefinition: currentTaskDefinitionArn,
              runningCount: 1,
              desiredCount: 1,
              status: "ACTIVE"
            }
          ]
        };
      }
      if (command instanceof DescribeTaskDefinitionCommand) {
        return {
          taskDefinition: {
            containerDefinitions: options.containerDefinitions.map((container) => ({
              ...container
            })),
            taskRoleArn: "arn:aws:iam::741005527903:role/task-role",
            executionRoleArn: "arn:aws:iam::741005527903:role/execution-role",
            networkMode: "awsvpc"
          }
        };
      }
      if (command instanceof RegisterTaskDefinitionCommand) {
        return { taskDefinition: { taskDefinitionArn: registeredTaskDefinitionArn } };
      }
      if (command instanceof UpdateServiceCommand) {
        return { service: { taskDefinition: registeredTaskDefinitionArn } };
      }
      throw new Error("unexpected command sent to stub");
    });

    return calls;
  }

  it("registers the stg image for django_app stage, leaves a non-matching sidecar untouched, and updates the staging cluster", async () => {
    const { service } = getSkillBrewService("django_app");
    const adapter = new AwsEcsAdapter(loadSkillBrewConfig());
    const calls = stubForceDeploy(adapter, {
      containerDefinitions: [
        {
          name: "django_app",
          image: "741005527903.dkr.ecr.ap-south-1.amazonaws.com/skillbrew-be:old"
        },
        { name: "nginx-sidecar", image: "some-other-registry/nginx:1.25" }
      ]
    });

    await adapter.forceDeploy(service, "stage");

    const registerCall = calls.find(
      (call): call is RegisterTaskDefinitionCommand => call instanceof RegisterTaskDefinitionCommand
    );
    expect(registerCall?.input.family).toBe("skillbrew-staging-django_app");

    const containers = registerCall?.input.containerDefinitions ?? [];
    const djangoContainer = containers.find((container) => container.name === "django_app");
    expect(djangoContainer?.image).toBe(
      "741005527903.dkr.ecr.ap-south-1.amazonaws.com/skillbrew-be:stg"
    );
    expect(djangoContainer?.image).not.toContain(":stage");

    const sidecar = containers.find((container) => container.name === "nginx-sidecar");
    expect(sidecar?.image).toBe("some-other-registry/nginx:1.25");

    const updateCall = calls.find(
      (call): call is UpdateServiceCommand => call instanceof UpdateServiceCommand
    );
    expect(updateCall?.input.cluster).toBe("skillbrew-staging-cluster");
  });

  it("round-trips dev to dev and prod to prod image tags", async () => {
    const { service } = getSkillBrewService("django_app");

    for (const [environment, expectedTag] of [
      ["dev", "dev"],
      ["prod", "prod"]
    ] as const satisfies ReadonlyArray<readonly [Environment, string]>) {
      const adapter = new AwsEcsAdapter(loadSkillBrewConfig());
      const calls = stubForceDeploy(adapter, {
        containerDefinitions: [
          {
            name: "django_app",
            image: "741005527903.dkr.ecr.ap-south-1.amazonaws.com/skillbrew-be:old"
          }
        ]
      });

      await adapter.forceDeploy(service, environment);

      const registerCall = calls.find(
        (call): call is RegisterTaskDefinitionCommand =>
          call instanceof RegisterTaskDefinitionCommand
      );
      const djangoContainer = registerCall?.input.containerDefinitions?.find(
        (container) => container.name === "django_app"
      );
      expect(djangoContainer?.image).toBe(
        `741005527903.dkr.ecr.ap-south-1.amazonaws.com/skillbrew-be:${expectedTag}`
      );
    }
  });

  it("registers the preprod image for django_app preprod on the staging cluster (preprod has no dedicated infra)", async () => {
    const { service } = getSkillBrewService("django_app");
    const adapter = new AwsEcsAdapter(loadSkillBrewConfig());
    const calls = stubForceDeploy(adapter, {
      containerDefinitions: [
        {
          name: "django_app",
          image: "741005527903.dkr.ecr.ap-south-1.amazonaws.com/skillbrew-be:old"
        }
      ]
    });

    await adapter.forceDeploy(service, "preprod");

    const registerCall = calls.find(
      (call): call is RegisterTaskDefinitionCommand => call instanceof RegisterTaskDefinitionCommand
    );
    expect(registerCall?.input.family).toBe("skillbrew-staging-django_app");

    const djangoContainer = registerCall?.input.containerDefinitions?.find(
      (container) => container.name === "django_app"
    );
    expect(djangoContainer?.image).toBe(
      "741005527903.dkr.ecr.ap-south-1.amazonaws.com/skillbrew-be:preprod"
    );

    const updateCall = calls.find(
      (call): call is UpdateServiceCommand => call instanceof UpdateServiceCommand
    );
    expect(updateCall?.input.cluster).toBe("skillbrew-staging-cluster");
  });

  describe("waitForStable", () => {
    afterEach(() => {
      delete process.env.STABILITY_TIMEOUT_MS;
      delete process.env.STABILITY_POLL_DELAY_MS;
    });

    /** Loads a config with a tiny timeout/poll delay so these tests exercise the real poll loop
     * (including the timeout path) without introducing real multi-second sleeps into the suite. */
    function loadFastStabilityConfig(timeoutMs: number, pollDelayMs: number): AppConfig {
      process.env.STABILITY_TIMEOUT_MS = String(timeoutMs);
      process.env.STABILITY_POLL_DELAY_MS = String(pollDelayMs);
      return loadSkillBrewConfig();
    }

    function describeServicesResult(options: {
      rolloutState: string;
      runningCount: number;
      desiredCount: number;
      pendingCount: number;
      lastServiceEvent: string;
      extraDeployment?: boolean;
    }): unknown {
      return {
        services: [
          {
            runningCount: options.runningCount,
            desiredCount: options.desiredCount,
            pendingCount: options.pendingCount,
            deployments: [
              {
                status: "PRIMARY",
                rolloutState: options.rolloutState,
                runningCount: options.runningCount,
                desiredCount: options.desiredCount,
                pendingCount: options.pendingCount
              },
              ...(options.extraDeployment
                ? [{ status: "ACTIVE", rolloutState: "IN_PROGRESS", runningCount: 1, desiredCount: 1 }]
                : [])
            ],
            events: [{ message: options.lastServiceEvent }]
          }
        ]
      };
    }

    it("polls DescribeServices until the rollout reaches COMPLETED, calling onProgress with in-flight snapshots then a final stable one", async () => {
      const { service } = getSkillBrewService("django_app");
      const config = loadFastStabilityConfig(5000, 1);
      const adapter = new AwsEcsAdapter(config);

      let call = 0;
      stubSend(adapter, async (command) => {
        if (!(command instanceof DescribeServicesCommand)) {
          throw new Error("unexpected command sent to stub");
        }
        call += 1;
        if (call === 1) {
          return describeServicesResult({
            rolloutState: "IN_PROGRESS",
            runningCount: 0,
            desiredCount: 1,
            pendingCount: 1,
            lastServiceEvent: "(service sample-service-stage) has begun draining connections"
          });
        }
        return describeServicesResult({
          rolloutState: "COMPLETED",
          runningCount: 1,
          desiredCount: 1,
          pendingCount: 0,
          lastServiceEvent: "(service sample-service-stage) has reached a steady state"
        });
      });

      const snapshots: StabilityProgress[] = [];
      await adapter.waitForStable(service, "stage", (progress) => {
        snapshots.push(progress);
      });

      expect(call).toBe(2);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0]).toMatchObject({ rolloutState: "IN_PROGRESS", runningCount: 0, desiredCount: 1 });
      expect(snapshots[1]).toMatchObject({ rolloutState: "COMPLETED", runningCount: 1, desiredCount: 1 });
    });

    it("throws ecs_not_stable once the configured timeout elapses while the rollout stays IN_PROGRESS", async () => {
      const { service } = getSkillBrewService("django_app");
      const config = loadFastStabilityConfig(20, 5);
      const adapter = new AwsEcsAdapter(config);

      stubSend(adapter, async (command) => {
        if (!(command instanceof DescribeServicesCommand)) {
          throw new Error("unexpected command sent to stub");
        }
        return describeServicesResult({
          rolloutState: "IN_PROGRESS",
          runningCount: 0,
          desiredCount: 1,
          pendingCount: 1,
          lastServiceEvent: "still pulling image"
        });
      });

      await expect(adapter.waitForStable(service, "stage")).rejects.toMatchObject({
        statusCode: 504,
        code: "ecs_not_stable"
      });
    });

    it("throws ecs_not_stable immediately when ECS reports a FAILED rollout, without waiting for the timeout", async () => {
      const { service } = getSkillBrewService("django_app");
      const config = loadFastStabilityConfig(5000, 5000);
      const adapter = new AwsEcsAdapter(config);

      stubSend(adapter, async (command) => {
        if (!(command instanceof DescribeServicesCommand)) {
          throw new Error("unexpected command sent to stub");
        }
        return describeServicesResult({
          rolloutState: "FAILED",
          runningCount: 0,
          desiredCount: 1,
          pendingCount: 0,
          lastServiceEvent: "task failed to start: CannotPullContainerError"
        });
      });

      await expect(adapter.waitForStable(service, "stage")).rejects.toMatchObject({
        statusCode: 504,
        code: "ecs_not_stable"
      });
    });

    it("does not consider the rollout stable while a lingering ACTIVE deployment remains alongside the COMPLETED PRIMARY", async () => {
      const { service } = getSkillBrewService("django_app");
      const config = loadFastStabilityConfig(20, 5);
      const adapter = new AwsEcsAdapter(config);

      stubSend(adapter, async (command) => {
        if (!(command instanceof DescribeServicesCommand)) {
          throw new Error("unexpected command sent to stub");
        }
        return describeServicesResult({
          rolloutState: "COMPLETED",
          runningCount: 1,
          desiredCount: 1,
          pendingCount: 0,
          lastServiceEvent: "steady state",
          extraDeployment: true
        });
      });

      await expect(adapter.waitForStable(service, "stage")).rejects.toMatchObject({
        statusCode: 504,
        code: "ecs_not_stable"
      });
    });

    it("tolerates a transient DescribeServices error by continuing to poll instead of failing the wait immediately", async () => {
      const { service } = getSkillBrewService("django_app");
      const config = loadFastStabilityConfig(5000, 1);
      const adapter = new AwsEcsAdapter(config);

      let call = 0;
      stubSend(adapter, async (command) => {
        if (!(command instanceof DescribeServicesCommand)) {
          throw new Error("unexpected command sent to stub");
        }
        call += 1;
        if (call === 1) {
          throw new Error("ThrottlingException: Rate exceeded");
        }
        return describeServicesResult({
          rolloutState: "COMPLETED",
          runningCount: 1,
          desiredCount: 1,
          pendingCount: 0,
          lastServiceEvent: "steady state"
        });
      });

      const snapshots: StabilityProgress[] = [];
      await adapter.waitForStable(service, "stage", (progress) => {
        snapshots.push(progress);
      });

      expect(call).toBe(2);
      expect(snapshots[0]?.message).toContain("DescribeServices error");
      expect(snapshots[1]).toMatchObject({ rolloutState: "COMPLETED" });
    });
  });
});
