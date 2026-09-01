# 02 — IAM & Permissions (Heimdall's AWS access)

This is the **"what to push"** for Heimdall's side: the exact IAM the Heimdall Lambda's
execution role needs so it can list/re-tag ECR images and force ECS deployments for the
SkillBrew services. Every permission below maps to a real AWS SDK call in
[`apps/api/src/integrations/aws-adapters.ts`](../../apps/api/src/integrations/aws-adapters.ts).

Account: **`741005527903`** · Region: **`ap-south-1`**

---

## 1. Exact API calls Heimdall makes (traceable to code)

| Heimdall action | SDK command (`aws-adapters.ts`) | IAM action |
|-----------------|----------------------------------|------------|
| List releases for a service | `paginateDescribeImages` (`listReleases`, L59-100) | `ecr:DescribeImages` |
| Validate a selected release | `DescribeImagesCommand` (`findRelease`, L109) | `ecr:DescribeImages` |
| Read an env's current digest | `DescribeImagesCommand` (`getEnvironmentDigest`, L140) | `ecr:DescribeImages` |
| Fetch manifest to re-tag | `BatchGetImageCommand` (`promoteEnvironmentTag`, L161) | `ecr:BatchGetImage` |
| Move the env pointer tag | `PutImageCommand` (`promoteEnvironmentTag`, L177) | `ecr:PutImage` |
| Read current ECS service | `DescribeServicesCommand` (`getCurrentState`, L199) | `ecs:DescribeServices` |
| Read current task def | `DescribeTaskDefinitionCommand` (`forceDeploy`, L232) | `ecs:DescribeTaskDefinition` |
| Register new task def revision | `RegisterTaskDefinitionCommand` (`forceDeploy`, L247) | `ecs:RegisterTaskDefinition` + `iam:PassRole` |
| Force a new deployment | `UpdateServiceCommand` (`forceDeploy`/`rollback`, L272/L289) | `ecs:UpdateService` |
| Wait for stability | `waitUntilServicesStable` (polls DescribeServices, L302) | `ecs:DescribeServices` |

Plus the control-plane essentials:

| Concern | IAM actions |
|---------|-------------|
| Heimdall's own state | `dynamodb:*Item` + `Query`/`Scan` on its 4 tables |
| Async deploy worker (self-invoke) | `lambda:InvokeFunction` on its own function ARN |
| Logs | `logs:CreateLogGroup` / `CreateLogStream` / `PutLogEvents` |

> **Note on `ecr:GetAuthorizationToken`:** *not required.* Heimdall only re-`PutImage`s an
> existing manifest fetched via `BatchGetImage` — it never uploads layers or does a `docker
> login`. Do not add it. (Your app CI needs it for pushing; Heimdall does not.)

> **Note on `iam:PassRole`:** `RegisterTaskDefinition` copies the current task def's
> `taskRoleArn` and `executionRoleArn` onto the new revision (see `aws-adapters.ts` L250-251).
> AWS requires the caller to have `iam:PassRole` for **both** roles. This is the single most
> commonly-missed permission — deploys will fail at "register task definition" without it.

---

## 2. The scoped IAM policy (recommended for production)

Replace the sandbox template's `Resource: "*"` grants with these scoped statements. Fill in the
real task/execution role ARNs of the managed services for `PassRole`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EcrReadAndRetag",
      "Effect": "Allow",
      "Action": [
        "ecr:DescribeImages",
        "ecr:BatchGetImage",
        "ecr:PutImage"
      ],
      "Resource": [
        "arn:aws:ecr:ap-south-1:741005527903:repository/skillbrew-be",
        "arn:aws:ecr:ap-south-1:741005527903:repository/skillbrew_ai"
        // …one ARN per managed ECR repo (13 services). See doc 03 for the full list.
      ]
    },
    {
      "Sid": "EcsReadTaskDefs",
      "Effect": "Allow",
      "Action": "ecs:DescribeTaskDefinition",
      "Resource": "*"
    },
    {
      "Sid": "EcsRegisterTaskDefs",
      "Effect": "Allow",
      "Action": "ecs:RegisterTaskDefinition",
      "Resource": "*"
    },
    {
      "Sid": "EcsDescribeAndDeployServices",
      "Effect": "Allow",
      "Action": [
        "ecs:DescribeServices",
        "ecs:UpdateService"
      ],
      "Resource": [
        "arn:aws:ecs:ap-south-1:741005527903:service/skillbrew-dev-cluster/*",
        "arn:aws:ecs:ap-south-1:741005527903:service/skillbrew-staging-cluster/*",
        "arn:aws:ecs:ap-south-1:741005527903:service/skillbrew-prod-cluster/*"
      ],
      "Condition": {
        "ArnEquals": {
          "ecs:cluster": [
            "arn:aws:ecs:ap-south-1:741005527903:cluster/skillbrew-dev-cluster",
            "arn:aws:ecs:ap-south-1:741005527903:cluster/skillbrew-staging-cluster",
            "arn:aws:ecs:ap-south-1:741005527903:cluster/skillbrew-prod-cluster"
          ]
        }
      }
    },
    {
      "Sid": "PassTaskAndExecutionRoles",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:aws:iam::741005527903:role/skillbrew-*-task-role",
        "arn:aws:iam::741005527903:role/skillbrew-*-execution-role"
        // …match the actual task/execution role ARNs used by your task definitions.
      ],
      "Condition": {
        "StringEquals": { "iam:PassedToService": "ecs-tasks.amazonaws.com" }
      }
    },
    {
      "Sid": "HeimdallStateTables",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan"
      ],
      "Resource": [
        "arn:aws:dynamodb:ap-south-1:741005527903:table/heimdall-*"
      ]
    },
    {
      "Sid": "AsyncDeployWorkerSelfInvoke",
      "Effect": "Allow",
      "Action": "lambda:InvokeFunction",
      "Resource": "arn:aws:lambda:ap-south-1:741005527903:function:heimdall-api"
    }
  ]
}
```

> `ecs:DescribeTaskDefinition` and `ecs:RegisterTaskDefinition` **do not support
> resource-level scoping** in IAM (task definitions can't be constrained by ARN on register),
> so they use `Resource: "*"`. This is an AWS limitation, not an oversight. Everything else is
> tightly scoped to SkillBrew's ECR repos and the three clusters.

`logs:*` for the Lambda's own log group is added automatically by the standard
`AWSLambdaBasicExecutionRole` managed policy attached in the stack (doc 04).

---

## 3. Why `Resource: "*"` in the sandbox template, and what to change

The sandbox `infra/aws/deployment-center-lambda.yml` used broad `Resource: "*"` for ECR/ECS to
keep the demo simple. **For SkillBrew production, replace those two broad statements with the
scoped policy above.** Concretely, in the template's Lambda role:

- Swap the wildcard ECR statement → `EcrReadAndRetag` (per-repo ARNs).
- Swap the wildcard ECS statement → `EcsReadTaskDefs` + `EcsRegisterTaskDefs` + `EcsDescribeAndDeployServices`.
- **Add** the `PassTaskAndExecutionRoles` statement (the sandbox didn't need it because its
  sample task defs had no custom task/execution roles; SkillBrew's do).
- Keep the DynamoDB and self-invoke statements (already present from the async-deploy work),
  re-scoped to `ap-south-1`/`741005527903`.

---

## 4. What Heimdall does **not** need

- ❌ No GitHub / repo access of any kind.
- ❌ No `ecr:GetAuthorizationToken`, no layer upload/download actions.
- ❌ No `ecs:RunTask`, `ecs:CreateService`, cluster/ALB/EC2 mutation — Heimdall never creates
  or destroys infra; it only re-tags images and rolls existing services.
- ❌ No access to application data stores, secrets of the services, or the VPC data plane.

Least privilege: Heimdall can *move a pointer tag* and *restart a service on a new revision*.
It cannot create infrastructure, read app secrets, or reach the running containers.

Proceed to [`03-service-catalog.md`](./03-service-catalog.md).
