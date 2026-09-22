#!/usr/bin/env bash
# Heimdall demo lifecycle: provisions every AWS resource needed for a live
# Deployment Center demo, and tears them all down again.
#
# Usage:
#   ./scripts/demo.sh [up|down|help]
#   ./scripts/demo.sh          # up, then block in the foreground; Ctrl+C tears down
#
# See docs/demo/README.md for the full runbook.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------------------------------------------------------------------------
# Config (env-overridable)
# ---------------------------------------------------------------------------
AWS_REGION="${AWS_REGION:-us-east-1}"
PROJECT_NAME="${PROJECT_NAME:-deploy2dev}"
SERVICE_NAME="${SERVICE_NAME:-sample-service}"
SANDBOX_STACK="${SANDBOX_STACK:-deploy2dev-sandbox}"
OIDC_STACK="${OIDC_STACK:-dummy-app-gha-oidc}"
HEIMDALL_STACK="${HEIMDALL_STACK:-heimdall}"
GITHUB_REPO="${GITHUB_REPO:-Naman-cell/deploy2dev-dummy-app}"
SEED_ADMIN_EMAIL="${SEED_ADMIN_EMAIL:-skillbrewmediahouse@gmail.com}"

# Resolved lazily (need ACCOUNT_ID first) — leave empty here so the
# `${VAR:-default}` pattern below still honors a caller-provided override.
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-}"
JWT_SECRET="${JWT_SECRET:-}"
SEED_ADMIN_PASSWORD="${SEED_ADMIN_PASSWORD:-}"

SANDBOX_TEMPLATE="${ROOT_DIR}/infra/aws/demo/deploy2dev-sandbox.yml"
OIDC_TEMPLATE="${ROOT_DIR}/infra/aws/dummy-app/github-oidc-ecr-push.yml"
HEIMDALL_TEMPLATE="${ROOT_DIR}/infra/aws/deployment-center-lambda.yml"
STATE_FILE="${ROOT_DIR}/scripts/.demo-state.txt"

# Populated during `up` / `down`; used by print_summary / write_demo_state.
ACCOUNT_ID=""
ECR_REPO_URI=""
ECR_REPO_NAME=""
ECS_CLUSTER_NAME=""
SERVICE_URL=""
STAGE_SERVICE_URL=""
PROD_SERVICE_URL=""
ROLE_ARN=""
API_URL=""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log() { printf '\n[demo] %s\n' "$*"; }
warn() { printf '\n[demo][WARN] %s\n' "$*" >&2; }
die() {
  printf '\n[demo][ERROR] %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage: $(basename "${BASH_SOURCE[0]}") [up|down|help]

Heimdall demo lifecycle: provisions the sandbox ECS/ECR stack, a GitHub
OIDC push role for the dummy app, and the Heimdall control plane, then
prints a demo runbook. Tears everything back down on request.

Commands:
  up       Provision everything, print a summary, exit 0 (resources stay up).
  down     Tear down all demo resources (best-effort; keeps going on errors).
  help     Show this help.
  (none)   Run 'up', then block in the foreground. Press Ctrl+C to tear
           everything down automatically.

Environment variables (all optional, shown with their defaults):
  AWS_REGION            us-east-1
  PROJECT_NAME          deploy2dev
  SERVICE_NAME          sample-service
  SANDBOX_STACK         deploy2dev-sandbox
  OIDC_STACK            dummy-app-gha-oidc
  HEIMDALL_STACK        heimdall
  GITHUB_REPO           Naman-cell/deploy2dev-dummy-app
  SEED_ADMIN_EMAIL      skillbrewmediahouse@gmail.com
  ARTIFACT_BUCKET       heimdall-artifacts-<account-id> (computed)
  JWT_SECRET            random (openssl rand -hex 32)
  SEED_ADMIN_PASSWORD   random (Hd-\$(openssl rand -hex 12))
EOF
}

# stack_output <stack-name> <output-key>
stack_output() {
  local stack="$1" key="$2" value
  value="$(aws cloudformation describe-stacks \
    --region "$AWS_REGION" \
    --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue | [0]" \
    --output text)"
  if [[ -z "$value" || "$value" == "None" ]]; then
    die "Stack ${stack} has no output value for '${key}' (got empty/None) — check the stack's Outputs."
  fi
  printf '%s\n' "$value"
}

# deploy_stack <stack-name> <template-file> [aws cloudformation deploy args...]
# Tolerates "No changes to deploy" as success; any other failure is fatal.
deploy_stack() {
  local stack="$1" template="$2"
  shift 2
  log "Deploying stack: ${stack}"
  local out
  if out="$(aws cloudformation deploy \
    --region "$AWS_REGION" \
    --stack-name "$stack" \
    --template-file "$template" \
    "$@" 2>&1)"; then
    printf '%s\n' "$out"
    log "Stack ${stack} deployed successfully."
    return 0
  fi
  printf '%s\n' "$out"
  if printf '%s' "$out" | grep -qi "No changes to deploy"; then
    log "Stack ${stack} is already up to date (no changes to deploy)."
    return 0
  fi
  die "Failed to deploy stack ${stack}. See output above."
}

# teardown_stack <stack-name>
# Best-effort: logs a warning and returns 1 on any failure instead of aborting.
teardown_stack() {
  local stack="$1"
  log "Deleting stack: ${stack}"
  if ! aws cloudformation delete-stack --region "$AWS_REGION" --stack-name "$stack" 2>&1; then
    warn "delete-stack failed for ${stack} (it may not exist) — continuing."
    return 1
  fi
  if ! aws cloudformation wait stack-delete-complete --region "$AWS_REGION" --stack-name "$stack" 2>&1; then
    warn "Timed out or failed waiting for ${stack} deletion — check the CloudFormation console."
    return 1
  fi
  log "Stack ${stack} deleted."
  return 0
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
preflight() {
  log "Running preflight checks..."

  local cmd
  for cmd in aws gh node npm openssl; do
    command -v "$cmd" >/dev/null 2>&1 || die "Required command not found on PATH: ${cmd}"
  done

  ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
    || die "aws sts get-caller-identity failed — check your AWS credentials/profile."
  [[ -n "$ACCOUNT_ID" && "$ACCOUNT_ID" != "None" ]] || die "Could not resolve AWS account id."

  gh auth status >/dev/null 2>&1 || die "gh auth status failed — run 'gh auth login' first."

  ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-heimdall-artifacts-${ACCOUNT_ID}}"
  if [[ -z "$JWT_SECRET" ]]; then
    JWT_SECRET="$(openssl rand -hex 32)"
  fi
  if [[ -z "$SEED_ADMIN_PASSWORD" ]]; then
    SEED_ADMIN_PASSWORD="Hd-$(openssl rand -hex 12)"
  fi

  log "Account:         ${ACCOUNT_ID}"
  log "Region:          ${AWS_REGION}"
  log "Sandbox stack:   ${SANDBOX_STACK}"
  log "OIDC stack:      ${OIDC_STACK}"
  log "Heimdall stack:  ${HEIMDALL_STACK}"
  log "Artifact bucket: ${ARTIFACT_BUCKET}"
  log "GitHub repo:     ${GITHUB_REPO}"
}

# ---------------------------------------------------------------------------
# up
# ---------------------------------------------------------------------------
cmd_up() {
  preflight

  log "Step 1/5: sandbox ECS/ECR stack"
  deploy_stack "$SANDBOX_STACK" "$SANDBOX_TEMPLATE" \
    --capabilities CAPABILITY_IAM \
    --parameter-overrides ProjectName="$PROJECT_NAME" ServiceName="$SERVICE_NAME"

  ECR_REPO_URI="$(stack_output "$SANDBOX_STACK" EcrRepositoryUri)"
  ECR_REPO_NAME="$(stack_output "$SANDBOX_STACK" EcrRepositoryName)"
  ECS_CLUSTER_NAME="$(stack_output "$SANDBOX_STACK" EcsClusterName)"
  SERVICE_URL="$(stack_output "$SANDBOX_STACK" ServiceUrl)"
  STAGE_SERVICE_URL="$(stack_output "$SANDBOX_STACK" StageServiceUrl)"
  PROD_SERVICE_URL="$(stack_output "$SANDBOX_STACK" ProdServiceUrl)"
  local ecr_arn="arn:aws:ecr:${AWS_REGION}:${ACCOUNT_ID}:repository/${ECR_REPO_NAME}"

  log "Step 2/5: GitHub OIDC provider + push role"
  local provider_arn="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
  if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$provider_arn" >/dev/null 2>&1; then
    log "Account GitHub OIDC provider already exists."
  else
    log "Creating account GitHub OIDC provider..."
    aws iam create-open-id-connect-provider \
      --url https://token.actions.githubusercontent.com \
      --client-id-list sts.amazonaws.com \
      --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 1c58a3a8518e8759bf075b76b750d4f2df264fcd \
      >/dev/null
  fi

  local github_owner="${GITHUB_REPO%%/*}"
  local github_repo_name="${GITHUB_REPO##*/}"
  if [[ "$github_owner" == "$GITHUB_REPO" || -z "$github_repo_name" ]]; then
    die "GITHUB_REPO must be in 'owner/repo' form, got: ${GITHUB_REPO}"
  fi

  local github_org_id github_repo_id
  github_org_id="$(gh api "users/${github_owner}" --jq .id)" \
    || die "Failed to resolve GitHub owner id for ${github_owner}"
  github_repo_id="$(gh api "repos/${GITHUB_REPO}" --jq .id)" \
    || die "Failed to resolve GitHub repo id for ${GITHUB_REPO}"

  deploy_stack "$OIDC_STACK" "$OIDC_TEMPLATE" \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides \
    GitHubOrg="$github_owner" \
    GitHubRepo="$github_repo_name" \
    GitHubOrgId="$github_org_id" \
    GitHubRepoId="$github_repo_id" \
    EcrRepositoryArn="$ecr_arn" \
    CreateOidcProvider=false

  ROLE_ARN="$(stack_output "$OIDC_STACK" RoleArn)"

  log "Step 3/5: point ${GITHUB_REPO} Actions at this account"
  gh variable set AWS_ROLE_ARN -R "$GITHUB_REPO" -b "$ROLE_ARN"
  gh variable set AWS_REGION -R "$GITHUB_REPO" -b "$AWS_REGION"
  gh variable set ECR_REPOSITORY_URI -R "$GITHUB_REPO" -b "$ECR_REPO_URI"

  log "Step 4/5: artifact bucket + Lambda package"
  if ! aws s3api head-bucket --bucket "$ARTIFACT_BUCKET" >/dev/null 2>&1; then
    log "Creating artifact bucket s3://${ARTIFACT_BUCKET}..."
    aws s3 mb "s3://${ARTIFACT_BUCKET}" --region "$AWS_REGION"
  fi

  (cd "$ROOT_DIR" && npm run package:lambda)

  local lambda_key
  lambda_key="heimdall/heimdall-lambda-$(date -u +%Y%m%d%H%M%S).zip"
  aws s3 cp "${ROOT_DIR}/build/heimdall-lambda.zip" "s3://${ARTIFACT_BUCKET}/${lambda_key}" --region "$AWS_REGION"

  log "Step 5/5: Heimdall control plane"
  deploy_stack "$HEIMDALL_STACK" "$HEIMDALL_TEMPLATE" \
    --capabilities CAPABILITY_IAM \
    --parameter-overrides \
    ProjectName="$PROJECT_NAME" \
    LambdaCodeBucket="$ARTIFACT_BUCKET" \
    LambdaCodeKey="$lambda_key" \
    JwtSecret="$JWT_SECRET" \
    SeedAdminEmail="$SEED_ADMIN_EMAIL" \
    SeedAdminPassword="$SEED_ADMIN_PASSWORD"

  API_URL="$(stack_output "$HEIMDALL_STACK" ApiUrl)"

  print_summary
  write_demo_state
}

print_summary() {
  local sep
  sep="$(printf '=%.0s' {1..78})"
  local clone_dir
  clone_dir="$(basename "$GITHUB_REPO")"
  cat <<EOF

${sep}
 HEIMDALL DEMO — READY
${sep}

 Heimdall URL:      ${API_URL}
 Admin email:       ${SEED_ADMIN_EMAIL}
 Admin password:    ${SEED_ADMIN_PASSWORD}

 ECR repository:    ${ECR_REPO_URI}
 ECS cluster:       ${ECS_CLUSTER_NAME}
   dev service:     ${SERVICE_NAME}-dev
   stage service:   ${SERVICE_NAME}-stage
   prod service:    ${SERVICE_NAME}-prod

 ALB URLs:
   dev   (:80)   -> ${SERVICE_URL}
   stage (:8081) -> ${STAGE_SERVICE_URL}
   prod  (:8082) -> ${PROD_SERVICE_URL}

 Dummy app repo:    https://github.com/${GITHUB_REPO}
 Push a commit to trigger a build:
   git clone https://github.com/${GITHUB_REPO}.git
   cd ${clone_dir}
   git commit --allow-empty -m "trigger demo build"
   git push

${sep}
 DEMO RUNBOOK
${sep}
 1. Everything above is provisioned and running right now.
 2. Push a commit to ${GITHUB_REPO} (commands above) — GitHub Actions
    builds the image and pushes it to ECR tagged sha-<shortsha>.
 3. Watch CI:              gh run watch -R ${GITHUB_REPO}
 4. Open the Heimdall URL, log in with the admin credentials above, then
    Deployment Center -> Sample Service -> dev -> pick the sha-<shortsha>
    release -> Deploy (returns 202 immediately, then polls to completion).
 5. AWS Console -> ECS -> cluster ${ECS_CLUSTER_NAME} -> service
    ${SERVICE_NAME}-dev to watch the new task/deployment roll out, then
    refresh the dev ALB URL (${SERVICE_URL}) to see the new build.
${sep}

 Full details (including credentials) were also written to:
   ${STATE_FILE}
${sep}

EOF
}

write_demo_state() {
  cat >"$STATE_FILE" <<EOF
Heimdall demo state — generated $(date -u +"%Y-%m-%dT%H:%M:%SZ")

Heimdall URL:          ${API_URL}
Admin email:           ${SEED_ADMIN_EMAIL}
Admin password:        ${SEED_ADMIN_PASSWORD}
JWT secret:            ${JWT_SECRET}

ECR repository URI:    ${ECR_REPO_URI}
ECR repository name:   ${ECR_REPO_NAME}
ECS cluster:           ${ECS_CLUSTER_NAME}
  dev service:         ${SERVICE_NAME}-dev   -> ${SERVICE_URL}
  stage service:       ${SERVICE_NAME}-stage -> ${STAGE_SERVICE_URL}
  prod service:        ${SERVICE_NAME}-prod  -> ${PROD_SERVICE_URL}

GitHub dummy-app repo: ${GITHUB_REPO}
GitHub OIDC role ARN:  ${ROLE_ARN}

Artifact bucket:       ${ARTIFACT_BUCKET}
Account:               ${ACCOUNT_ID}
Region:                ${AWS_REGION}

Stacks:
  Sandbox stack:       ${SANDBOX_STACK}
  OIDC stack:          ${OIDC_STACK}
  Heimdall stack:      ${HEIMDALL_STACK}
EOF
  chmod 600 "$STATE_FILE" 2>/dev/null || true
  log "Wrote recovery state to ${STATE_FILE}"
}

# ---------------------------------------------------------------------------
# down
# ---------------------------------------------------------------------------
cmd_down() {
  log "Starting teardown (best-effort — failures are logged and teardown continues)..."
  local failures=0

  if [[ -z "$ACCOUNT_ID" ]]; then
    ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
      || warn "Could not resolve AWS account id (aws CLI/credentials unavailable?)."
  fi
  if [[ -z "$ARTIFACT_BUCKET" && -n "$ACCOUNT_ID" ]]; then
    ARTIFACT_BUCKET="heimdall-artifacts-${ACCOUNT_ID}"
  fi

  teardown_stack "$HEIMDALL_STACK" || { warn "Heimdall stack (${HEIMDALL_STACK}) teardown had issues."; failures=$((failures + 1)); }

  teardown_stack "$OIDC_STACK" || { warn "OIDC role stack (${OIDC_STACK}) teardown had issues."; failures=$((failures + 1)); }
  log "Note: the account-level GitHub OIDC provider was left in place — it is account-global and other repos may depend on it."

  teardown_stack "$SANDBOX_STACK" \
    || { warn "Sandbox stack (${SANDBOX_STACK}) teardown had issues (EcrRepository has EmptyOnDelete=true, so images should clear automatically)."; failures=$((failures + 1)); }

  if [[ -n "$ARTIFACT_BUCKET" ]] && aws s3api head-bucket --bucket "$ARTIFACT_BUCKET" >/dev/null 2>&1; then
    log "Emptying and removing artifact bucket s3://${ARTIFACT_BUCKET}..."
    aws s3 rm "s3://${ARTIFACT_BUCKET}" --recursive || { warn "Failed to empty s3://${ARTIFACT_BUCKET}."; failures=$((failures + 1)); }
    aws s3 rb "s3://${ARTIFACT_BUCKET}" || { warn "Failed to remove bucket s3://${ARTIFACT_BUCKET}."; failures=$((failures + 1)); }
  else
    log "Artifact bucket ${ARTIFACT_BUCKET:-<unknown, ARTIFACT_BUCKET/ACCOUNT_ID unresolved>} not found — skipping."
  fi

  log "Note: GitHub repo ${GITHUB_REPO} and its Actions variables were intentionally left in place; the next 'up' refreshes them."

  if [[ "$failures" -eq 0 ]]; then
    log "Teardown complete: all resources removed successfully."
  else
    warn "Teardown finished with ${failures} issue(s) — review the warnings above."
  fi
}

# ---------------------------------------------------------------------------
# Foreground mode (no subcommand)
# ---------------------------------------------------------------------------
TEARDOWN_STARTED=0
foreground_teardown() {
  # Guard against re-entrancy: a second INT/TERM while teardown is already
  # in progress (e.g. an impatient double Ctrl+C) must not run cmd_down
  # concurrently with itself — just let the first teardown keep going.
  if [[ "$TEARDOWN_STARTED" -eq 1 ]]; then
    return
  fi
  TEARDOWN_STARTED=1
  echo
  log "Caught interrupt — tearing everything down..."
  cmd_down
  exit 0
}

run_foreground() {
  # Arm the trap before provisioning so an interrupt at any point —
  # including mid-provision — tears everything back down.
  trap foreground_teardown INT TERM
  cmd_up
  log "Resources are UP. Press Ctrl+C to tear everything down."
  while true; do
    sleep 5
  done
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
main() {
  local sub="${1:-}"
  case "$sub" in
    up)
      cmd_up
      ;;
    down)
      cmd_down
      ;;
    -h | --help | help)
      usage
      ;;
    "")
      run_foreground
      ;;
    *)
      usage >&2
      die "Unknown subcommand: ${sub}"
      ;;
  esac
}

main "$@"
