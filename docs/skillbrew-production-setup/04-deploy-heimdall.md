# 04 — Deploy the Heimdall Control Plane

This deploys **only** the Heimdall control plane into SkillBrew's account: one Lambda
(API + async worker + static web UI), four DynamoDB tables, its IAM role, and the API Gateway
HTTP API. **No ECS/ALB/ECR is created** — those already exist and are managed via the catalog.

Account: **`741005527903`** · Region: **`ap-south-1`**

---

## 0. Prepare the template for production

Start from `infra/aws/deployment-center-lambda.yml` (the sandbox template) and apply these
production changes **before** deploying. Consider copying it to
`infra/aws/heimdall-skillbrew.yml` so the sandbox template stays untouched.

1. **Scope the IAM role** — replace the wildcard ECR/ECS statements with the scoped policy from
   [`02-iam-and-permissions.md`](./02-iam-and-permissions.md), and **add the `iam:PassRole`
   statement** for the services' task/execution roles.
2. **Remove `SERVICE_CATALOG: sandbox`** from the Lambda's `Environment.Variables`. In
   production the bundled 13-service catalog must be used (doc 03), not the single sample.
3. **Confirm these env vars remain set** on the Lambda:
   - `DATA_STORE: dynamodb`
   - `AWS_INTEGRATION: aws`   ← makes Heimdall use the real ECR/ECS adapters (not mocks)
   - `STATIC_ASSETS_DIR: public`  ← serves the bundled web UI
   - the four DynamoDB table-name vars (wired to the tables the stack creates)
   - `JWT_SECRET`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` (from stack params)
   - **Do not** hard-code `AWS_REGION` — the Lambda runtime injects it; deploying the stack in
     `ap-south-1` is what sets the region.
4. **Keep the async-deploy settings** (already in the template from prior work):
   - Lambda `Timeout: 360`
   - `AWS::Lambda::EventInvokeConfig` with `MaximumRetryAttempts: 0`
   - the self-invoke `lambda:InvokeFunction` permission + `AWS::Lambda::Permission`
5. **Secrets:** prefer sourcing `JwtSecret`/`SeedAdminPassword` from Secrets Manager/SSM at
   deploy time rather than typing them on the CLI. Never commit them.

---

## 1. Build & package the Lambda artifact

The bundle contains the API (with the 13-service catalog) + the built web UI.

```bash
cd /path/to/Deploy2Dev
npm ci
npm run validate          # typecheck → lint → test → build (must be green)
npm run package:lambda    # → build/heimdall-lambda.zip
```

`package:lambda` runs the full workspace build, esbuild-bundles `apps/api/src/lambda.ts`, and
copies the built web UI into `public/`. Verify the catalog is bundled (not the sandbox one).

---

## 2. Upload the artifact to S3 (ap-south-1)

```bash
REGION=ap-south-1
BUCKET=heimdall-artifacts-741005527903
aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null || \
  aws s3 mb "s3://$BUCKET" --region $REGION

KEY="heimdall/heimdall-lambda-$(date -u +%Y%m%d%H%M%S).zip"
aws s3 cp build/heimdall-lambda.zip "s3://$BUCKET/$KEY" --region $REGION
echo "KEY=$KEY"
```

---

## 3. Deploy the stack

```bash
REGION=ap-south-1

aws cloudformation deploy \
  --region $REGION \
  --stack-name heimdall \
  --template-file infra/aws/heimdall-skillbrew.yml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ProjectName=heimdall \
    LambdaCodeBucket=heimdall-artifacts-741005527903 \
    LambdaCodeKey="$KEY" \
    JwtSecret="<from Secrets Manager>" \
    SeedAdminEmail="<admin email>" \
    SeedAdminPassword="<strong password>"
```

> **Deploying IAM requires `CAPABILITY_IAM`.** If you gave the role an explicit `RoleName`, use
> `CAPABILITY_NAMED_IAM` instead. The person/role running this needs CloudFormation + IAM
> role-creation permissions (this is the *deployer*, not Heimdall's runtime role).

Get the API URL:

```bash
aws cloudformation describe-stacks --region $REGION --stack-name heimdall \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text
```

Subsequent updates: rebuild → repackage → upload a new `KEY` → re-run `deploy` overriding only
`LambdaCodeBucket`/`LambdaCodeKey` (other params retain previous values).

---

## 4. Smoke-test the control plane

```bash
API=$(aws cloudformation describe-stacks --region ap-south-1 --stack-name heimdall \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)

curl -s "$API/health"          # → {"status":"ok",...}
```

Then in a browser open `$API`, log in as the seed admin, and confirm:
- **Deployment Center** lists all 13 services.
- The **Environment** dropdown shows `dev, stage, preprod, prod`.
- Selecting a service + `dev` lists real ECR releases (proves ECR read + catalog wiring).

> If `/health` is OK but the UI login POST fails, it's almost always the web `API_BASE`. The
> app strips a leading `/api` server-side, so the bundled UI works at the API root; if you
> front Heimdall with a custom domain/path, build the web app with `VITE_API_BASE` set to match.

**Rotate the seed admin password after first login.** Create real users (admin/user) in the
Users screen.

---

## 5. Post-deploy IAM validation (prove least-privilege works end-to-end)

Do a **dev** deploy of one service (doc 06). If it fails, the error localizes the missing grant:

| Failure point | Missing permission |
|---------------|--------------------|
| Listing releases returns empty / 500 | `ecr:DescribeImages` on that repo |
| Promote step 404/AccessDenied | `ecr:BatchGetImage` or `ecr:PutImage` on that repo |
| "register task definition" AccessDenied | `ecs:RegisterTaskDefinition` **or** `iam:PassRole` on the task/exec roles |
| Force deploy AccessDenied | `ecs:UpdateService` (check the `ecs:cluster` condition) |
| Stuck then 504 `ecs_not_stable` | Not IAM — the new task is failing health checks (app/infra issue) |

Proceed to [`05-app-repo-ci-onboarding.md`](./05-app-repo-ci-onboarding.md).
