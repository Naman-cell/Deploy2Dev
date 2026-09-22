# 01 — Prerequisites

Before deploying Heimdall into the SkillBrew account, confirm the following already exist and
collect the listed values. Heimdall **manages** existing infrastructure — it does not create
your clusters, services, task definitions, ECR repos, or load balancers.

Target account: **`741005527903`** · Region: **`ap-south-1`**

---

## A. Infrastructure that must already exist

For **every** service Heimdall will manage, and for **every** environment (`dev`, `stage`,
`preprod`, `prod`):

- [ ] **ECR repository** holding the service's images (e.g. `skillbrew-be`, `skillbrew_ai`).
- [ ] **ECS cluster** — `skillbrew-dev-cluster`, `skillbrew-staging-cluster`, `skillbrew-prod-cluster`.
- [ ] **ECS service** running in that cluster (Heimdall calls `UpdateService` on it — it must exist and be `ACTIVE`).
- [ ] **A task definition family** with at least one registered revision (Heimdall reads the *current* revision, swaps the container image, and registers a new revision).
- [ ] The service's task definition already references a valid **task role** and **execution role** (Heimdall re-uses these ARNs when registering the new revision — see IAM `PassRole` in doc 02).
- [ ] The container to update is named consistently — this becomes `containerName` in the catalog.

> **Pre-prod note:** pre-prod does *not* need its own cluster/service. It reuses the **stage**
> service on `skillbrew-staging-cluster`. It only needs its own ECR pointer tag `:preprod`
> (which Heimdall creates on first promote). No new infra required for pre-prod.

### Image tagging contract

Heimdall promotes by **digest**, and it moves environment **pointer tags**. Your app CI must
push **immutable, content-addressable tags** (e.g. `sha-<gitsha>`) so a specific build can be
selected and promoted. The environment pointer tags (`dev`, `stg`, `preprod`, `prod`) are
owned and moved by Heimdall — CI should **not** push those. See doc 05.

---

## B. Values to collect (per service × environment)

You will need these to fill `service-catalog.json` (doc 03). Discovery commands are in doc 03.

| Field | Example | Notes |
|-------|---------|-------|
| `serviceId` | `django_app` | Stable internal id (already set in the catalog) |
| `ecrRepository` | `skillbrew-be` | ECR repo **name** |
| `ecrRepositoryUri` | `741005527903.dkr.ecr.ap-south-1.amazonaws.com/skillbrew-be` | Full URI |
| `containerName` | `django_app` | Name of the container in the task def to re-image |
| `clusterName` (per env) | `skillbrew-dev-cluster` | The ECS cluster for that env |
| `serviceName` (per env) | `django_app` | The ECS service name in that cluster |
| `taskFamily` (per env) | `skillbrew-dev-django_app` | Task definition family |
| `environmentTag` (per env) | `dev` / `stg` / `preprod` / `prod` | ECR pointer tag for that env |

> Most of these are **already populated** in `apps/api/src/service-catalog.json` for all 13
> services. Your job in doc 03 is to **verify them against the live account** and replace the
> `githubRepository` `TODO-*` placeholders (display-only metadata).

---

## C. Heimdall control-plane prerequisites

- [ ] **DynamoDB tables** for Heimdall's own state (users, deployments, deployment-events, locks).
      These are **created by the Heimdall CloudFormation stack** (doc 04) — you do *not* pre-create them.
- [ ] **A JWT signing secret** (random 32+ bytes). Store it in **AWS Secrets Manager** or SSM
      Parameter Store (SecureString), not in source. Passed to the stack as `JwtSecret`.
- [ ] **A seed admin** email + strong password (passed as `SeedAdminEmail` / `SeedAdminPassword`).
      Created once on first boot; rotate the password after first login. Additional users are
      created in-app by an admin.
- [ ] **An S3 bucket** in `ap-south-1` to hold the Lambda deployment artifact (zip). Doc 04
      creates/uses one (e.g. `heimdall-artifacts-741005527903`).
- [ ] **Deployer credentials** — a human/CI principal with permission to run CloudFormation and
      create the Lambda's IAM role (i.e. `CAPABILITY_IAM`). This is the person running doc 04,
      **not** the Heimdall runtime role.

---

## D. Networking

Heimdall calls the **AWS control-plane APIs** (ECR, ECS, DynamoDB, Lambda) over public AWS
service endpoints. It does **not** need to sit inside the VPC that runs your ECS tasks, and it
does not talk to the tasks directly. Therefore:

- [ ] No VPC attachment is required for the Heimdall Lambda by default.
- [ ] If SkillBrew policy mandates that all AWS API traffic stay on the private network, you
      can optionally run the Lambda in a VPC with **VPC endpoints** for `ecr.api`, `ecr.dkr`
      (only if pushing layers — Heimdall doesn't), `ecs`, `dynamodb`, and `sts`. This is an
      optional hardening step, not a functional requirement.

---

## E. Region alignment ⚠️

The sandbox ran in `us-east-1`. SkillBrew is **`ap-south-1`**. Ensure:

- [ ] The Lambda is deployed in `ap-south-1` (the runtime auto-injects `AWS_REGION`, and the app
      reads it — no code change needed, but the **stack must be deployed in `ap-south-1`**).
- [ ] The ECR URIs in the catalog use `ap-south-1`.
- [ ] The artifact S3 bucket is in `ap-south-1`.

Proceed to [`02-iam-and-permissions.md`](./02-iam-and-permissions.md).
