import { z } from "zod";

export const environments = ["dev", "stage", "preprod", "prod"] as const;
export const roles = ["admin", "user"] as const;
export const deploymentStatuses = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "rolled_back"
] as const;

export const EnvironmentSchema = z.enum(environments);
export const RoleSchema = z.enum(roles);
export const DeploymentStatusSchema = z.enum(deploymentStatuses);

export type Environment = z.infer<typeof EnvironmentSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>;

export const UserSchema = z.object({
  userId: z.string(),
  email: z.string().email(),
  name: z.string(),
  role: RoleSchema,
  status: z.enum(["active", "disabled"]),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type User = z.infer<typeof UserSchema>;

export const EnvironmentTagSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/);

export const ServiceEnvironmentSchema = z.object({
  clusterName: z.string(),
  serviceName: z.string(),
  taskFamily: z.string(),
  environmentTag: EnvironmentTagSchema
});

export const ServiceSchema = z.object({
  serviceId: z.string(),
  name: z.string(),
  githubRepository: z.string(),
  ecrRepository: z.string(),
  ecrRepositoryUri: z.string().optional(),
  containerName: z.string(),
  environments: z.record(EnvironmentSchema, ServiceEnvironmentSchema),
  allowedDeployRolesByEnvironment: z.record(EnvironmentSchema, z.array(RoleSchema))
});

export type DeploymentService = z.infer<typeof ServiceSchema>;

export const ReleaseSchema = z.object({
  tag: z.string(),
  digest: z.string(),
  pushedAt: z.string().optional(),
  source: z.enum(["manual", "dev", "stage", "preprod", "prod", "hotfix", "unknown"]),
  isEnvironmentPointer: z.boolean(),
  sourceBranch: z.string().optional()
});

export type Release = z.infer<typeof ReleaseSchema>;

export const DeploymentEventSchema = z.object({
  deploymentId: z.string(),
  timestamp: z.string(),
  phase: z.string(),
  status: DeploymentStatusSchema,
  message: z.string(),
  metadata: z.record(z.unknown()).optional()
});

export type DeploymentEvent = z.infer<typeof DeploymentEventSchema>;

export const DeploymentSchema = z.object({
  deploymentId: z.string(),
  serviceId: z.string(),
  serviceName: z.string(),
  environment: EnvironmentSchema,
  requestedBy: z.string(),
  requestedByEmail: z.string(),
  selectedImageTag: z.string(),
  selectedImageDigest: z.string(),
  previousEnvironmentImageDigest: z.string().optional(),
  previousTaskDefinitionArn: z.string().optional(),
  newTaskDefinitionArn: z.string().optional(),
  status: DeploymentStatusSchema,
  startedAt: z.string(),
  completedAt: z.string().optional(),
  errorMessage: z.string().optional(),
  correlationId: z.string(),
  events: z.array(DeploymentEventSchema)
});

export type Deployment = z.infer<typeof DeploymentSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const CreateDeploymentRequestSchema = z.object({
  serviceId: z.string(),
  environment: EnvironmentSchema,
  imageTag: z.string().min(1),
  imageDigest: z.string().min(1)
});

export type CreateDeploymentRequest = z.infer<typeof CreateDeploymentRequestSchema>;

export const CreateUserRequestSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(12),
  role: RoleSchema
});

export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

export interface CurrentServiceState {
  serviceId: string;
  environment: Environment;
  clusterName: string;
  serviceName: string;
  currentTaskDefinitionArn?: string;
  environmentImageDigest?: string;
  runningCount?: number;
  desiredCount?: number;
  status?: string;
}

export function canDeploy(role: Role, environment: Environment): boolean {
  if (environment === "prod" || environment === "preprod") {
    return role === "admin";
  }

  return role === "admin" || role === "user";
}

export function classifyReleaseTag(tag: string): Release["source"] {
  if (tag === "dev" || tag === "stage" || tag === "prod") {
    return tag;
  }
  if (tag === "stg" || tag === "staging") {
    return "stage";
  }
  if (tag === "preprod" || tag === "pre-prod") {
    return "preprod";
  }
  if (tag.startsWith("hotfix-")) {
    return "hotfix";
  }
  if (tag.startsWith("dev-")) {
    return "dev";
  }
  if (tag.startsWith("stage-") || tag.startsWith("stg-") || tag.startsWith("staging-")) {
    return "stage";
  }
  if (tag.startsWith("preprod-") || tag.startsWith("pre-prod-")) {
    return "preprod";
  }
  if (tag.startsWith("prod-")) {
    return "prod";
  }
  if (tag.startsWith("branch-") || tag.startsWith("user-") || tag.startsWith("sha-")) {
    return "manual";
  }
  return "unknown";
}

// Matches CI's `branch-<sanitized-branch>-<shortsha>` tag convention. The branch group is
// non-greedy so it stops expanding as soon as the remainder can be consumed as a one-or-more-dash
// separator followed by a 7-40 char hex sha anchored to the end of the tag — this correctly
// handles both the single-dash form (`branch-main-fa867dc`) and the double-dash form CI actually
// produces when the sanitizer leaves a trailing separator dash (`branch-main--fa867dc`), and it
// does not swallow a hex-looking suffix of the branch name itself (e.g.
// `branch-feature-abcdef1-1234567` parses to branch `feature-abcdef1`, not `feature`).
const RELEASE_BRANCH_TAG_PATTERN = /^branch-(.+?)-+[0-9a-f]{7,40}$/;

/** Derives the source branch from an image's full set of ECR tags, or `undefined` if none of the
 * tags match the `branch-<branch>-<sha>` convention (e.g. an image only tagged `sha-<shortsha>`). */
export function branchFromImageTags(tags: string[]): string | undefined {
  for (const tag of tags) {
    const match = RELEASE_BRANCH_TAG_PATTERN.exec(tag);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

/** True for `main` and any sanitized `release-*`/unsanitized `release/*` branch name. */
export function isReleaseBranch(branch: string | undefined): boolean {
  if (!branch) {
    return false;
  }
  return branch === "main" || branch.startsWith("release-") || branch.startsWith("release/");
}

/** preprod/prod are release-gated; dev/stage are unrestricted. */
export function requiresReleaseBranch(environment: Environment): boolean {
  return environment === "preprod" || environment === "prod";
}

/** Server-authoritative (and UI-mirrored) gate: preprod/prod only accept images built from a
 * release branch; dev/stage accept anything. */
export function isReleaseEligibleForEnvironment(
  environment: Environment,
  release: Pick<Release, "sourceBranch">
): boolean {
  return !requiresReleaseBranch(environment) || isReleaseBranch(release.sourceBranch);
}

export function environmentPointerTags(service: DeploymentService): Set<string> {
  const tags = new Set<string>();
  for (const environment of environments) {
    const config = service.environments[environment];
    if (config) {
      tags.add(config.environmentTag);
    }
  }
  return tags;
}
