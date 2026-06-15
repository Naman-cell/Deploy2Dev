import { describe, expect, it } from "vitest";
import { canDeploy, classifyReleaseTag } from "./index";

describe("shared deployment policy helpers", () => {
  it("allows only admins to deploy prod", () => {
    expect(canDeploy("admin", "prod")).toBe(true);
    expect(canDeploy("user", "prod")).toBe(false);
  });

  it("allows users and admins to deploy non-prod environments", () => {
    expect(canDeploy("user", "dev")).toBe(true);
    expect(canDeploy("user", "stage")).toBe(true);
    expect(canDeploy("admin", "stage")).toBe(true);
  });

  it("classifies Skillbrew release tags", () => {
    expect(classifyReleaseTag("branch-feature-auth-a1b2c3d")).toBe("manual");
    expect(classifyReleaseTag("dev-20260603-42-a1b2c3d")).toBe("dev");
    expect(classifyReleaseTag("stage-20260603-18-d4e5f6a")).toBe("stage");
    expect(classifyReleaseTag("hotfix-20260603-7-ab12cd3")).toBe("hotfix");
  });
});
