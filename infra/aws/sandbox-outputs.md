# Heimdall Sandbox Outputs

Created in the sandbox AWS account and region selected by the operator.

## CloudFormation

```text
STACK_NAME=deploy2dev-sandbox
```

## ECR

```text
ECR_REPOSITORY_NAME=deploy2dev/sample-service
ECR_REPOSITORY_URI=<aws-account-id>.dkr.ecr.<aws-region>.amazonaws.com/deploy2dev/sample-service
```

Settings:

- Image scanning on push: enabled
- Image tag mutability: mutable, because `dev`, `stage`, and `prod` are environment pointer tags

## ECS

```text
ECS_CLUSTER_NAME=deploy2dev-dev
ECS_SERVICE_NAME=sample-service-dev
ECS_STAGE_CLUSTER_NAME=deploy2dev-dev
ECS_STAGE_SERVICE_NAME=sample-service-stage
ECS_PROD_CLUSTER_NAME=deploy2dev-dev
ECS_PROD_SERVICE_NAME=sample-service-prod
ECS_TASK_FAMILY=deploy2dev-sample-service-dev
ECS_STAGE_TASK_FAMILY=deploy2dev-sample-service-stage
ECS_PROD_TASK_FAMILY=deploy2dev-sample-service-prod
ECS_CONTAINER_NAME=app
SERVICE_URL=<sandbox-alb-url>
STAGE_SERVICE_URL=<sandbox-alb-url>:8081
PROD_SERVICE_URL=<sandbox-alb-url>:8082
```

Verified service state:

```text
DEV_STATUS=ACTIVE
DEV_DESIRED_COUNT=1
DEV_RUNNING_COUNT=1
STAGE_STATUS=ACTIVE
STAGE_DESIRED_COUNT=1
STAGE_RUNNING_COUNT=1
PROD_STATUS=ACTIVE
PROD_DESIRED_COUNT=1
PROD_RUNNING_COUNT=1
```

The sandbox keeps `dev`, `stage`, and `prod` as separate ECS services in the same low-cost ECS cluster.
This is for personal-account E2E testing only; production should use Skillbrew's confirmed account,
cluster, network, approval, and isolation model.

## CircleCI IAM

```text
CIRCLECI_IAM_USER=circleci-deploy2dev-sandbox
CIRCLECI_DEPLOY_POLICY_ARN=<circleci-deploy-policy-arn>
```

No access key secret is stored in this repository.

Recommended CircleCI environment variables:

```text
AWS_ACCESS_KEY_ID=<create for circleci-deploy2dev-sandbox>
AWS_SECRET_ACCESS_KEY=<create for circleci-deploy2dev-sandbox>
AWS_REGION=us-east-1
AWS_ACCOUNT_ID=<aws-account-id>
ECR_REPOSITORY_URI=<aws-account-id>.dkr.ecr.<aws-region>.amazonaws.com/deploy2dev/sample-service
ECS_CLUSTER_NAME=deploy2dev-dev
ECS_SERVICE_NAME=sample-service-dev
ECS_TASK_FAMILY=deploy2dev-sample-service-dev
ECS_CONTAINER_NAME=app
```

Create the CircleCI IAM access key in AWS Console or with the AWS CLI, then paste it directly into CircleCI project environment variables. Do not commit or paste the secret key into chat.

## Heimdall Application

```text
HEIMDALL_URL=<api-gateway-url>
HEIMDALL_STACK_NAME=heimdall
HEIMDALL_ARTIFACT_BUCKET=<heimdall-artifact-bucket>
```

Seeded admin for sandbox testing:

```text
SEED_ADMIN_EMAIL=<initial-admin-email>
SEED_ADMIN_PASSWORD=<initial-admin-password>
```

Never commit or publish the seeded admin password. Rotate it before any non-local/shared demo.
