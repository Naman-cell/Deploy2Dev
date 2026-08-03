# Heimdall

Web portal for controlled deployments across `dev`, `stage`, and `prod`.

## Current Stack

- Frontend: React, Vite, TypeScript
- Backend/API: Express-compatible Lambda handler, TypeScript
- Data store: memory locally, DynamoDB when deployed
- Registry/deploy target: ECR and ECS
- Quality checks: CircleCI
- Image builds: CircleCI

## Local Development

```bash
npm install
cp .env.example .env
npm run dev
```

Open the frontend at `http://127.0.0.1:5173`.

Default local login is created from `.env`:

```text
SEED_ADMIN_EMAIL=<initial-admin-email>
SEED_ADMIN_PASSWORD=<initial-admin-password>
```

Local mode uses mock ECR/ECS adapters and an in-memory data store by default. No AWS credentials are required unless `AWS_INTEGRATION=aws`.

## Live Sandbox

Heimdall can be deployed to a personal AWS sandbox with the scripts under `scripts/` and CloudFormation templates under `infra/aws/`.

```text
HEIMDALL_URL=<api-gateway-url>
```

The sample ECS services are exposed by the sandbox load balancer:

```text
DEV_SERVICE_URL=<sandbox-alb-url>
STAGE_SERVICE_URL=<sandbox-alb-url>:8081
PROD_SERVICE_URL=<sandbox-alb-url>:8082
```

Do not publish seeded admin credentials or long-lived sandbox endpoints in source control.

## Validation

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npm run validate
```

## Deployment Model

Heimdall treats immutable image tags/digests as real releases and treats `:dev`, `:stage`, and `:prod` as movable ECS environment pointers.

The backend deployment flow:

1. Validate user, service, environment, and selected image.
2. Reject prod deploys unless the user is an admin.
3. Resolve release tag to ECR image digest.
4. Acquire a per-service/environment lock.
5. Record the previous environment digest and task definition.
6. Move the environment tag to the selected digest.
7. Force ECS deployment.
8. Wait for ECS service stability.
9. Record deployment events and final status.

## CI/CD Split

CircleCI runs quality checks and image builds for the sandbox/test flow.

CircleCI supports:

- manual branch builds create branch/user/SHA/run tags
- `dev` and `stage` branch pushes create stable env release tags
- normal `stage` to `prod` promotion should not build a new image
- `hotfix/*` pushes can create hotfix image tags

Manual CircleCI image build trigger should pass pipeline parameter:

```text
run_image_build=true
```

The default sample image build uses:

```text
dockerfile=sample-service/Dockerfile
docker_context=sample-service
ecr_repository=deploy2dev/sample-service
```

## Security Notes

- Do not commit AWS, GitHub, CircleCI, or user credentials.
- Do not expose tokens to the frontend.
- Passwords are hashed before storage.
- Prod deployment is admin-only.
- The Lambda IAM template is intentionally a foundation; tighten ECR/ECS resource ARNs once exact Skillbrew service mappings are confirmed.
