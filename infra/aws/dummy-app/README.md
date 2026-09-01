# Dummy App — GitHub Actions → ECR via OIDC

Self-contained scaffold for a throwaway GitHub repository whose CI builds a
Docker image and pushes an immutable tag straight to the Heimdall sandbox ECR
repository, using GitHub's OIDC identity federation instead of long-lived AWS
access keys.

The image is `nginx:alpine` serving a static page on port 80, so it drops
into the sandbox ECS task (`ContainerPort 80`, container name `app`) with no
task-definition changes.

## Files

- `Dockerfile` — `FROM nginx:alpine`, copies `index.html` in. Serves on port 80.
- `index.html` — branded placeholder page with `__BUILD_SHA__` / `__BUILD_DATE__`
  markers that CI stamps in, so a redeploy is visually obvious.
- `.github/workflows/build-push.yml` — the CI workflow. Lives here for
  reference; copy it to `.github/workflows/build-push.yml` at the root of the
  dummy GitHub repo.
- `github-oidc-ecr-push.yml` — CloudFormation template that provisions the
  IAM role the workflow assumes over OIDC.

## Runbook

### 1. Deploy the OIDC role

```bash
aws cloudformation deploy \
  --stack-name dummy-app-gha-oidc \
  --template-file infra/aws/dummy-app/github-oidc-ecr-push.yml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    GitHubOrg=<your-github-org-or-user> \
    GitHubRepo=<dummy-app-repo-name> \
    EcrRepositoryArn=arn:aws:ecr:us-east-1:<aws-account-id>:repository/deploy2dev/sample-service \
    CreateOidcProvider=true
```

Set `CreateOidcProvider=false` if the AWS account already has a
`token.actions.githubusercontent.com` OIDC provider registered (an account
can only have one — check under IAM → Identity providers first).

Grab the role ARN from the stack output:

```bash
aws cloudformation describe-stacks \
  --stack-name dummy-app-gha-oidc \
  --query "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue" \
  --output text
```

### 2. Create the dummy GitHub repo

Copy these files into the root of a new (throwaway) GitHub repository:

- `Dockerfile`
- `index.html`
- `.github/workflows/build-push.yml`

### 3. Set repo variables

In the dummy repo's Settings → Secrets and variables → Actions → Variables,
add:

| Variable             | Value                                                                  |
| --------------------- | ----------------------------------------------------------------------- |
| `AWS_ROLE_ARN`        | Role ARN from step 1                                                    |
| `AWS_REGION`          | `us-east-1`                                                              |
| `ECR_REPOSITORY_URI`  | `<aws-account-id>.dkr.ecr.us-east-1.amazonaws.com/deploy2dev/sample-service` |

No AWS access keys are needed anywhere — the workflow authenticates via
OIDC (`id-token: write` + `aws-actions/configure-aws-credentials`).

### 4. Push and deploy

Push a commit. CI runs `checks` (hadolint + a sanity check), then
`build-and-push`, which builds the image, stamps the commit SHA and build
date into the page, and pushes:

- `${ECR_REPOSITORY_URI}:sha-<short-sha>` (immutable, use this one)
- `${ECR_REPOSITORY_URI}:branch-<sanitized-branch>-<short-sha>`

Once the workflow's checks are green, open Heimdall and deploy the
`sha-<short-sha>` release to `dev` (and promote to `stage`/`prod` as usual).
The page will show the new build SHA once the ECS task rolls over.
