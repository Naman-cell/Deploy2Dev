# 05 — App Repo CI Onboarding (the ECR-push side)

This is the **other** access from doc 00 — the one that lives in each **microservice repo**,
not in Heimdall. Each SkillBrew service repo's GitHub Actions CI must build its image and push
it to that service's ECR repo, using a short-lived **OIDC role** (no long-lived AWS keys).
Heimdall then promotes those images.

This is per-repo and owned by the app teams. Heimdall has **no** involvement here beyond later
reading what CI pushed.

Account: **`741005527903`** · Region: **`ap-south-1`**

---

## What each repo needs

1. A GitHub **OIDC provider** in the AWS account (one per account, shared by all repos).
2. An **IAM role** per repo (or a shared role scoped by repo), assumable via OIDC, that can push
   to that repo's ECR repository.
3. A **build-and-push workflow** that assumes the role and pushes an **immutable** image tag.

Reusable CloudFormation + workflow templates already exist in the Heimdall repo under
[`infra/aws/dummy-app/`](../../infra/aws/dummy-app/) — they were validated end-to-end during
the sandbox test. Copy and adapt them per service.

---

## 1. The OIDC push role (CloudFormation)

Use [`infra/aws/dummy-app/github-oidc-ecr-push.yml`](../../infra/aws/dummy-app/github-oidc-ecr-push.yml).
It creates (optionally) the OIDC provider and a role scoped to a single ECR repo, trusting a
specific `owner/repo`.

> ⚠️ **GitHub immutable-identifier subject claim.** The live sandbox test proved that some
> GitHub orgs emit the OIDC `sub` in the **immutable** form
> `repo:OWNER@<ownerId>/REPO@<repoId>:...` rather than the classic `repo:OWNER/REPO:...`. The
> template's trust policy already matches **both** forms via a `StringLike` list, so you must
> supply the numeric IDs as parameters:
>
> ```bash
> gh api users/Brudite-Pvt-Ltd --jq .id          # → GitHubOrgId
> gh api repos/Brudite-Pvt-Ltd/<repo> --jq .id    # → GitHubRepoId
> ```

Deploy per service (first service also creates the OIDC provider; set `CreateOidcProvider=false`
for the rest):

```bash
REGION=ap-south-1
aws cloudformation deploy \
  --region $REGION \
  --stack-name gha-ecr-push-skillbrew-be \
  --template-file infra/aws/dummy-app/github-oidc-ecr-push.yml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    GitHubOrg=Brudite-Pvt-Ltd \
    GitHubRepo=<repo-name> \
    GitHubOrgId=<numeric-owner-id> \
    GitHubRepoId=<numeric-repo-id> \
    EcrRepositoryArn=arn:aws:ecr:ap-south-1:741005527903:repository/skillbrew-be \
    CreateOidcProvider=true   # false for every repo after the first
```

Output `RoleArn` → set it as the repo's `AWS_ROLE_ARN` GitHub **variable**.

> The role grants only ECR push to **one** repo (plus `ecr:GetAuthorizationToken`, which the
> *app* CI genuinely needs for `docker login`). It cannot touch ECS or other repos.

---

## 2. The build-and-push workflow

Use [`infra/aws/dummy-app/.github/workflows/build-push.yml`](../../infra/aws/dummy-app/.github/workflows/build-push.yml)
as the pattern (the OIDC-debug step was removed after the sandbox test — do not re-add it).
Set these GitHub repo **variables**: `AWS_ROLE_ARN`, `AWS_REGION=ap-south-1`,
`ECR_REPOSITORY_URI=741005527903.dkr.ecr.ap-south-1.amazonaws.com/<repo>`.

Key requirements for the workflow, so Heimdall can promote what it builds:

- `permissions: id-token: write` (for OIDC) + `contents: read`.
- Assume the role via `aws-actions/configure-aws-credentials@v4`.
- Push an **immutable** tag Heimdall can select — recommended `sha-<short-sha>` (and optionally
  `branch-<branch>-<sha>`).
- **Do not push the environment pointer tags** (`dev`, `stg`, `preprod`, `prod`). Those are
  Heimdall-owned; CI pushing them would fight Heimdall's promotion and corrupt the audit trail.

---

## 3. Branch → environment mapping (SkillBrew v2 workflow)

CI builds and pushes on every relevant branch; **Heimdall decides what gets promoted where.**
CI does not deploy to ECS.

| Branch | CI pushes to ECR | Then in Heimdall (manual, gated) |
|--------|------------------|----------------------------------|
| `develop` | `sha-<sha>` | promote to **dev** |
| `release/vX.Y.Z` | `sha-<sha>` | promote to **stage** |
| `pre-prod` | `sha-<sha>` | promote to **preprod** (admin) |
| `main` | `sha-<sha>` | promote to **prod** (admin) |

The same immutable `sha-<sha>` artifact is what you promote up the chain in Heimdall, so the
exact bytes tested in dev are the bytes that reach prod.

---

## Onboarding checklist (per service repo)

- [ ] ECR repo exists (doc 01).
- [ ] OIDC provider exists in the account (create once).
- [ ] Push role deployed for the repo; `RoleArn` set as `AWS_ROLE_ARN` variable.
- [ ] `AWS_REGION` + `ECR_REPOSITORY_URI` variables set.
- [ ] `build-push.yml` added; a test push produces `sha-<sha>` in ECR.
- [ ] Service present + verified in Heimdall's catalog (doc 03).
- [ ] A Heimdall **dev** deploy of that image succeeds (doc 06).

Proceed to [`06-environments-rbac-runbook.md`](./06-environments-rbac-runbook.md).
