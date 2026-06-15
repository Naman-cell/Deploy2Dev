#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_FILE="${ROOT_DIR}/infra/aws/cloudformation/deploy2dev-sandbox.yml"

STACK_NAME="${STACK_NAME:-deploy2dev-sandbox}"
PROJECT_NAME="${PROJECT_NAME:-deploy2dev}"
SERVICE_NAME="${SERVICE_NAME:-sample-service}"
AWS_REGION="${AWS_REGION:-us-east-1}"

echo "Provisioning Deploy to Dev sandbox stack"
echo "  stack:   ${STACK_NAME}"
echo "  project: ${PROJECT_NAME}"
echo "  service: ${SERVICE_NAME}"
echo "  region:  ${AWS_REGION}"

aws cloudformation deploy \
  --region "${AWS_REGION}" \
  --stack-name "${STACK_NAME}" \
  --template-file "${TEMPLATE_FILE}" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ProjectName="${PROJECT_NAME}" \
    ServiceName="${SERVICE_NAME}"

echo
echo "Stack outputs:"
aws cloudformation describe-stacks \
  --region "${AWS_REGION}" \
  --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[].{Key:OutputKey,Value:OutputValue}" \
  --output table
