# Heimdall → SkillBrew Production Setup

This directory is the **complete, streamlined runbook** for standing Heimdall up against
SkillBrew's *real* AWS infrastructure (account `741005527903`, region `ap-south-1`) and
onboarding the SkillBrew microservices so Heimdall can promote images and force ECS
deployments across `dev → stage → preprod → prod`.

> **The sandbox is not migrated.** Everything under `infra/aws/` that provisioned an ECS
> cluster, ALB, ECR repo, and sample service (`deploy2dev-sandbox`, the `dummy-app`, the
> `dummy-oidc` stack) was a **throwaway test rig**. SkillBrew already owns its clusters,
> services, task definitions, ECR repos, and load balancers. You deploy **only Heimdall's
> control plane** and point it at that existing infrastructure. Do **not** deploy the
> sandbox stack into the SkillBrew account.

---

## What Heimdall actually is (and what it touches)

Heimdall is a **control plane**, not a data plane. It runs as a single AWS Lambda (behind
an API Gateway HTTP API) plus four DynamoDB tables. It does **three** things to AWS:

1. **Reads ECR** — lists image tags/digests for a service so you can pick a release.
2. **Re-tags in ECR** — "promotes" the chosen image digest to an environment pointer tag
   (`dev` / `stg` / `preprod` / `prod`) by re-`PutImage`-ing the existing manifest. No
   image is rebuilt or re-pushed; only a tag moves.
3. **Forces an ECS rollout** — registers a new task-definition revision pointing at that
   pointer tag and calls `UpdateService … forceNewDeployment`, then waits for stability.

That is the entire AWS surface. See [`02-iam-and-permissions.md`](./02-iam-and-permissions.md)
for the exact API calls and the minimal IAM policy.

### The two accesses — keep them separate

A common misconception is that "Heimdall needs access to the microservice repos." **It does
not.** There are two independent grants, on two different sides:

| Grant | Who holds it | What it is | Where it's set up |
|-------|--------------|------------|-------------------|
| **ECR push** | Each **app repo's** GitHub Actions | An OIDC role that lets that repo's CI push a built image to its ECR repo | App repo side — see [`05-app-repo-ci-onboarding.md`](./05-app-repo-ci-onboarding.md) |
| **ECR read/re-tag + ECS deploy** | The **Heimdall Lambda** | An IAM role on the Lambda scoped to SkillBrew's ECR repos + ECS clusters/services | Heimdall side — see [`02-iam-and-permissions.md`](./02-iam-and-permissions.md) |

Heimdall never authenticates to GitHub. "Registering a service in Heimdall" means adding an
entry to [`service-catalog.json`](../../apps/api/src/service-catalog.json) — see
[`03-service-catalog.md`](./03-service-catalog.md).

---

## Architecture (production)

```
 Developer                GitHub                      AWS (741005527903, ap-south-1)
 ─────────                ──────                      ────────────────────────────────
  git push  ──▶  App repo CI (OIDC role)  ──push──▶  ECR: skillbrew-be:sha-<sha>
                                                              │
  Browser ──▶ Heimdall UI ──▶ API Gateway ──▶ Heimdall Lambda │  (control plane)
                                                    │         ▼
                                                    ├─ ECR: PutImage → move :dev/:stg/:preprod/:prod pointer
                                                    ├─ ECS: RegisterTaskDefinition (new revision → pointer tag)
                                                    ├─ ECS: UpdateService forceNewDeployment
                                                    └─ ECS: wait until stable
                                                              │
                                          skillbrew-{dev,staging,prod}-cluster runs the new task
```

---

## The four-environment model on SkillBrew

| Branch (source) | Heimdall env | ECS cluster | Pointer tag | Who can deploy |
|-----------------|--------------|-------------|-------------|----------------|
| `develop` | **dev** | `skillbrew-dev-cluster` | `dev` | admin + user |
| `release/vX.Y.Z` | **stage** | `skillbrew-staging-cluster` | `stg` | admin + user |
| `pre-prod` | **preprod** | `skillbrew-staging-cluster` *(shared with stage)* | `preprod` | **admin only** |
| `main` | **prod** | `skillbrew-prod-cluster` | `prod` | **admin only** |

**Pre-prod has no dedicated infrastructure.** It runs on the **stage cluster's** service but
carries its own distinct `:preprod` ECR pointer tag, giving it an independent audit trail and
rollback target on shared infra. This is intentional — see
[`06-environments-rbac-runbook.md`](./06-environments-rbac-runbook.md).

---

## Read the docs in this order

1. [`01-prerequisites.md`](./01-prerequisites.md) — what must already exist in the SkillBrew AWS account before you start, and the values to collect.
2. [`02-iam-and-permissions.md`](./02-iam-and-permissions.md) — the exact IAM policy for the Heimdall Lambda role (the "what to push" for Heimdall's AWS access), derived from the actual SDK calls.
3. [`03-service-catalog.md`](./03-service-catalog.md) — how to fill the service catalog for the 13 SkillBrew services, field-by-field, and how to discover each value from AWS.
4. [`04-deploy-heimdall.md`](./04-deploy-heimdall.md) — deploy the control plane (Lambda + DynamoDB + IAM). No sandbox infra.
5. [`05-app-repo-ci-onboarding.md`](./05-app-repo-ci-onboarding.md) — what each microservice repo needs (OIDC push role + image tagging) so its CI feeds ECR.
6. [`06-environments-rbac-runbook.md`](./06-environments-rbac-runbook.md) — the promotion flow, RBAC, first-deploy smoke test, rollback, and troubleshooting.

A one-page checklist lives at the end of [`06-environments-rbac-runbook.md`](./06-environments-rbac-runbook.md#go-live-checklist).
