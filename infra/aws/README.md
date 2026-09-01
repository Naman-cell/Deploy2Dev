# infra/aws

Infrastructure for deploying **Heimdall's control plane** and onboarding SkillBrew app repos.

> The production setup runbook lives in
> [`docs/skillbrew-production-setup/`](../../docs/skillbrew-production-setup/). Start there.

## Contents

- **`deployment-center-lambda.yml`** — CloudFormation for the Heimdall control plane: the
  Lambda (API + async worker + bundled web UI), four DynamoDB tables, its IAM role, and the API
  Gateway HTTP API. This is the **only** stack you deploy for Heimdall itself — it creates no
  ECS/ALB/ECR (those already exist and are managed via the service catalog). For SkillBrew,
  scope the IAM per [`docs/skillbrew-production-setup/02-iam-and-permissions.md`](../../docs/skillbrew-production-setup/02-iam-and-permissions.md)
  and deploy per [`04-deploy-heimdall.md`](../../docs/skillbrew-production-setup/04-deploy-heimdall.md).

- **`dummy-app/`** — reusable templates for onboarding an application repo's CI to push images
  to ECR via GitHub OIDC (no long-lived keys):
  - `github-oidc-ecr-push.yml` — per-repo OIDC push role (matches both classic and GitHub
    immutable-identifier `sub` claim formats).
  - `.github/workflows/build-push.yml` — the build-and-push workflow pattern.
  - `Dockerfile` / `index.html` — a tiny sample app used to validate the pipeline end-to-end.

  See [`docs/skillbrew-production-setup/05-app-repo-ci-onboarding.md`](../../docs/skillbrew-production-setup/05-app-repo-ci-onboarding.md).

## Deploy scripts (`../../scripts/`)

- `package-heimdall-lambda.sh` — build + esbuild-bundle + zip the Lambda artifact (`npm run package:lambda`).
- `deploy-heimdall-lambda.sh` — upload the artifact to S3 and `cloudformation deploy` the stack.

## Security

Never paste AWS access keys, secrets, or session tokens into chat, source, commits, or docs. Use
Secrets Manager / SSM for `JwtSecret` and the seed admin password, and OIDC federation (not
long-lived keys) for CI. If a credential is ever exposed, rotate it immediately.
