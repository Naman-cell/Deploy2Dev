#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${STACK_NAME:-deploy2dev-sandbox}"
AWS_REGION="${AWS_REGION:-us-east-1}"

echo "Deleting Deploy to Dev sandbox stack"
echo "  stack:  ${STACK_NAME}"
echo "  region: ${AWS_REGION}"

aws cloudformation delete-stack \
  --region "${AWS_REGION}" \
  --stack-name "${STACK_NAME}"

aws cloudformation wait stack-delete-complete \
  --region "${AWS_REGION}" \
  --stack-name "${STACK_NAME}"

echo "Deleted ${STACK_NAME}"
