# Heimdall live demo — one-script lifecycle

`scripts/demo.sh` provisions every AWS resource needed for a live Heimdall
Deployment Center demo and tears them all back down again. It's meant to be
run once right before the demo and stopped right after.

## Prerequisites

- AWS credentials for the demo account active in your shell (`aws sts
  get-caller-identity` must succeed) — e.g. via `AWS_PROFILE` or exported
  keys. The account needs permission to create VPCs, ECS, ECR, IAM
  roles/policies (including an OIDC provider), S3, Lambda, DynamoDB, and API
  Gateway resources.
- GitHub CLI authenticated: `gh auth status` must succeed, and the
  authenticated account must be able to set repo variables and read repo/user
  IDs on the dummy-app repo (`Naman-cell/deploy2dev-dummy-app` by default).
- `node`, `npm`, and `openssl` on `PATH` (used to build/package the Lambda
  bundle and generate secrets).
- Run `npm install` at the repo root at least once beforehand so
  `npm run package:lambda` has its dependencies available.

## The three commands

```bash
# Provision everything, print a summary + runbook, and exit 0.
# Resources stay up until you tear them down explicitly.
./scripts/demo.sh up

# Provision everything, then block in the foreground. Press Ctrl+C and it
# tears everything down automatically before exiting. This is the primary
# "start it, walk away, stop it" mode for the actual demo.
./scripts/demo.sh

# Tear everything down. Best-effort — it keeps going even if one step
# fails, and reports a final status line.
./scripts/demo.sh down
```

`-h` / `--help` / `help` prints usage.

## What gets created

1. **Sandbox stack** (`infra/aws/demo/deploy2dev-sandbox.yml`, default stack
   name `deploy2dev-sandbox`) — a VPC, an ALB with three listeners
   (`:80`/`:8081`/`:8082` for dev/stage/prod), an ECS cluster on a single EC2
   instance, one ECR repository, and three ECS services
   (`sample-service-{dev,stage,prod}`) seeded with a placeholder `nginx:alpine`
   task.
2. **GitHub OIDC push role** (`infra/aws/dummy-app/github-oidc-ecr-push.yml`,
   default stack name `dummy-app-gha-oidc`) — an IAM role the dummy app's
   GitHub Actions workflow assumes (no long-lived AWS keys) to push images to
   the ECR repo above. The account-level GitHub OIDC provider itself is
   created separately and idempotently (outside the stack) so repeated runs
   never collide with it.
3. **Heimdall control plane** (`infra/aws/deployment-center-lambda.yml`,
   default stack name `heimdall`) — the Lambda-backed API/worker, the static
   web UI, 4 DynamoDB tables, and an HTTP API Gateway in front of it. The
   script builds and packages the Lambda bundle (`npm run package:lambda`)
   and uploads it to an artifact S3 bucket before deploying.
4. The dummy app repo's Actions **variables** (`AWS_ROLE_ARN`, `AWS_REGION`,
   `ECR_REPOSITORY_URI`) are updated to point at this account/run.

The script also writes every URL/credential it produced to
`scripts/.demo-state.txt` (gitignored) so you can recover them if you lose
the terminal.

## Demo flow

1. Run `./scripts/demo.sh` (or `up`) and wait for the summary + runbook.
2. Push a commit to the dummy app repo — GitHub Actions builds the image and
   pushes it to ECR tagged `sha-<shortsha>`.
3. Watch the build: `gh run watch -R Naman-cell/deploy2dev-dummy-app`.
4. Open the Heimdall URL from the summary, log in with the printed admin
   email/password, then go to **Deployment Center → Sample Service → dev**,
   pick the new `sha-<shortsha>` release, and click **Deploy** (returns 202
   immediately, then the UI polls to completion).
5. In the AWS Console, open **ECS → cluster `deploy2dev-dev` → service
   `sample-service-dev`** to watch the new task/deployment roll out, then
   refresh the dev ALB URL to see the new build live.

## Cost and teardown

Every resource above costs money while it's running (an EC2 instance behind
an ALB, an idle Lambda + API Gateway + DynamoDB PAY_PER_REQUEST tables are all
cheap, but not free). Tear down as soon as the demo is over:

- If you started with the no-arg foreground mode, just press **Ctrl+C** —
  teardown runs automatically.
- Otherwise run `./scripts/demo.sh down` explicitly.

Teardown is best-effort: it deletes the Heimdall stack, then the OIDC role
stack, then the sandbox stack (the ECR repository has `EmptyOnDelete: true`
so pushed images don't block stack deletion), then empties and removes the
artifact S3 bucket. It intentionally **leaves in place**:

- The account-level GitHub OIDC provider (it's account-global — other repos
  may depend on it).
- The dummy app GitHub repo and its now-stale Actions variables (the next
  `up` refreshes them).

If a step fails, teardown logs a warning and keeps going rather than aborting
partway through; it prints a final status line summarizing how many steps had
issues.

## Environment variable overrides

All of these are optional — every one has a sensible default for a fresh run.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AWS_REGION` | `us-east-1` | Region for every stack and the artifact bucket. |
| `PROJECT_NAME` | `deploy2dev` | Short project name used in resource names. |
| `SERVICE_NAME` | `sample-service` | Name of the sample ECS service. |
| `SANDBOX_STACK` | `deploy2dev-sandbox` | CloudFormation stack name for the sandbox infra. |
| `OIDC_STACK` | `dummy-app-gha-oidc` | CloudFormation stack name for the GitHub OIDC push role. |
| `HEIMDALL_STACK` | `heimdall` | CloudFormation stack name for the Heimdall control plane. |
| `GITHUB_REPO` | `Naman-cell/deploy2dev-dummy-app` | `owner/repo` of the dummy app CI targets. |
| `SEED_ADMIN_EMAIL` | `skillbrewmediahouse@gmail.com` | Initial Heimdall admin login. |
| `ARTIFACT_BUCKET` | `heimdall-artifacts-<account-id>` (computed) | S3 bucket for the Lambda deployment package. |
| `JWT_SECRET` | random (`openssl rand -hex 32`) | Heimdall JWT signing secret. |
| `SEED_ADMIN_PASSWORD` | random (`Hd-$(openssl rand -hex 12)`) | Initial Heimdall admin password. |

Set any of these before invoking the script to override, e.g.:

```bash
AWS_REGION=us-west-2 SEED_ADMIN_EMAIL=you@example.com ./scripts/demo.sh up
```
