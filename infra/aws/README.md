# AWS Sandbox Prerequisites

This folder contains a minimal AWS sandbox for testing a future Deploy to Dev application before touching the real organization infrastructure.

It creates:

- One ECR repository for a sample service image.
- One ECS cluster using EC2 launch type.
- One EC2 container instance in a small public VPC.
- Three ECS services, `dev`, `stage`, and `prod`, with placeholder `nginx:alpine` tasks.
- One public ALB for browser-based sandbox verification.
- IAM task roles and an ECS instance role.
- One managed IAM policy that can be attached to the CircleCI identity used for sandbox deploys.

It does not store or create access keys.

## Security Note

Do not paste AWS passwords, access keys, session tokens, or secret values into chat, source files, commits, or docs. Configure credentials locally with the AWS CLI, and store CI credentials only in CircleCI project environment variables or contexts.

If credentials were exposed, rotate them before continuing.

## Provision

Configure local AWS credentials first:

```bash
aws configure
aws sts get-caller-identity
```

Then deploy the sandbox:

```bash
AWS_REGION=us-east-1 \
STACK_NAME=deploy2dev-sandbox \
PROJECT_NAME=deploy2dev \
SERVICE_NAME=sample-service \
./scripts/provision-aws-sandbox.sh
```

The script prints stack outputs including:

- ECR repository URI
- ECS cluster name
- ECS service names
- CircleCI deploy policy ARN

## CircleCI IAM

For the quick personal-account test, create a dedicated IAM user or role for CircleCI and attach the generated `CircleCiDeployPolicyArn`.

Recommended CircleCI environment variables:

```text
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_REGION
AWS_ACCOUNT_ID
ECR_REPOSITORY_URI
ECS_CLUSTER_NAME
ECS_SERVICE_NAME
ECS_TASK_FAMILY
ECS_CONTAINER_NAME=app
```

For stage/prod sandbox checks, use the corresponding `ECS_STAGE_*` and `ECS_PROD_*` values printed by the stack outputs.

For the real organization, prefer OIDC federation from CircleCI to AWS instead of long-lived access keys.

## Delete

```bash
AWS_REGION=us-east-1 \
STACK_NAME=deploy2dev-sandbox \
./scripts/delete-aws-sandbox.sh
```

If the ECR repository contains pushed images, empty it before deleting the stack.

## Sandbox Security Tradeoff

The sandbox template opens the ECS dynamic host-port range for browser-based ALB/ECS testing. This is for the personal sandbox only. For Skillbrew production, restrict dynamic ports to the ALB security group and use the organization's normal network controls.
