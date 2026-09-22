#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_NAME="${STACK_NAME:-heimdall}"
AWS_REGION="${AWS_REGION:-us-east-1}"
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-}"
JWT_SECRET="${JWT_SECRET:-}"
SEED_ADMIN_EMAIL="${SEED_ADMIN_EMAIL:-}"
SEED_ADMIN_PASSWORD="${SEED_ADMIN_PASSWORD:-}"
PACKAGE_FILE="${ROOT_DIR}/build/heimdall-lambda.zip"
TEMPLATE_FILE="${ROOT_DIR}/infra/aws/deployment-center-lambda.yml"

if [[ -z "${ARTIFACT_BUCKET}" ]]; then
  echo "ARTIFACT_BUCKET is required" >&2
  exit 1
fi

if [[ -z "${JWT_SECRET}" ]]; then
  echo "JWT_SECRET is required" >&2
  exit 1
fi

if [[ -z "${SEED_ADMIN_EMAIL}" ]]; then
  echo "SEED_ADMIN_EMAIL is required" >&2
  exit 1
fi

if [[ -z "${SEED_ADMIN_PASSWORD}" ]]; then
  echo "SEED_ADMIN_PASSWORD is required" >&2
  exit 1
fi

"${ROOT_DIR}/scripts/package-heimdall-lambda.sh"

aws s3api head-bucket --bucket "${ARTIFACT_BUCKET}" >/dev/null 2>&1 || \
  aws s3 mb "s3://${ARTIFACT_BUCKET}" --region "${AWS_REGION}"

OBJECT_KEY="heimdall/heimdall-lambda-$(date -u +%Y%m%d%H%M%S).zip"
aws s3 cp "${PACKAGE_FILE}" "s3://${ARTIFACT_BUCKET}/${OBJECT_KEY}" --region "${AWS_REGION}"

aws cloudformation deploy \
  --region "${AWS_REGION}" \
  --stack-name "${STACK_NAME}" \
  --template-file "${TEMPLATE_FILE}" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ProjectName="${STACK_NAME}" \
    LambdaCodeBucket="${ARTIFACT_BUCKET}" \
    LambdaCodeKey="${OBJECT_KEY}" \
    JwtSecret="${JWT_SECRET}" \
    SeedAdminEmail="${SEED_ADMIN_EMAIL}" \
    SeedAdminPassword="${SEED_ADMIN_PASSWORD}"

aws cloudformation describe-stacks \
  --region "${AWS_REGION}" \
  --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[].{Key:OutputKey,Value:OutputValue}" \
  --output table
