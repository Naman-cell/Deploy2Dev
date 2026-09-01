# 06 — Environments, RBAC & Operational Runbook

How promotion, access control, deploys, and rollbacks work day-to-day, plus troubleshooting and
a one-page go-live checklist.

---

## The promotion flow

Heimdall promotes the **same immutable image** (`sha-<sha>`) up the chain. Each promote:

1. Moves the environment **pointer tag** (`dev`/`stg`/`preprod`/`prod`) to the chosen digest in ECR.
2. Registers a **new task-def revision** whose managed container points at `<ecrUri>:<pointerTag>`.
3. Calls `UpdateService … forceNewDeployment` and **waits until the service is stable**.

```
develop ──▶ dev ──▶ release/vX.Y.Z ──▶ stage ──▶ pre-prod ──▶ preprod ──▶ main ──▶ prod
            (all)                       (all)                  (admin)              (admin)
```

Because it's digest-based, "promote to prod" ships the exact artifact validated in dev/stage.

### Pre-prod on shared infra — what to expect

Pre-prod uses the **stage** ECS service (`skillbrew-staging-cluster`). Consequences, all
intended:
- Deploying pre-prod **replaces what's running on the stage service** (they share it). Sequence
  stage → pre-prod deliberately (matches `release → pre-prod → main`).
- Pre-prod keeps its **own `:preprod` ECR pointer tag**, so its audit trail and rollback target
  are independent even though the compute is shared.
- `currentState(preprod)` reflects whatever was last deployed to the stage service (stage or
  preprod). This is inherent to shared infra.

---

## RBAC

Enforced **server-side** (`canDeploy` in `@heimdall/shared`) and mirrored in the UI. Two roles:

| Environment | `admin` | `user` |
|-------------|:-------:|:------:|
| dev | ✅ | ✅ |
| stage | ✅ | ✅ |
| **preprod** | ✅ | ❌ |
| **prod** | ✅ | ❌ |

- `user` = developers + QA (SkillBrew has no separate `qa` role; QA maps to `user`).
- `preprod` and `prod` are **admin-only** for every service.
- Rollback is gated by the **same** `canDeploy` check on the deployment's environment.
- Users are managed in-app (Users screen, admin-only). The seed admin bootstraps the first login.

To demo RBAC: create a `user`, log in as them — the Deploy button is disabled with a banner on
preprod/prod, enabled on dev/stage.

---

## Doing a deploy (operator steps)

1. Open the Heimdall UI (the `ApiUrl`), log in.
2. **Deployment Center** → pick the **Microservice** and **Environment**.
3. Pick the **Release** — an immutable `sha-<sha>` (not an env pointer tag).
4. **Deploy** → confirm. The API returns **202 immediately** and the row shows
   `pending → running → succeeded` as the UI polls. **It does not block the browser** even
   though the ECS rollout takes 30–120s (this is the async-worker design; the Lambda self-invokes
   a worker with a 360s budget while the HTTP request returns at once).
5. Verify via your normal service health/URL for that environment.

## Rollback

Each history row has **Rollback** (admin-gated the same as deploy). It re-points the ECS service
at the **previous task-definition revision** recorded on that deployment and waits for stability.
Like deploy, rollback is **async** (202 + poll) — the UI won't hang.

> Rollback needs a `previousTaskDefinitionArn` on the record (captured at deploy time). The very
> first deploy of a service has no prior revision to roll back to.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Release list empty | `ecr:DescribeImages` missing, wrong `ecrRepository`, or no images pushed | Check IAM (doc 02) + catalog (doc 03) + that CI pushed |
| Promote fails 404 `image_manifest_not_found` | Selected digest not in the repo | Re-select a valid `sha-<sha>` |
| Promote AccessDenied | `ecr:BatchGetImage`/`ecr:PutImage` missing on that repo | Doc 02 `EcrReadAndRetag` |
| "register task definition" AccessDenied | `ecs:RegisterTaskDefinition` or **`iam:PassRole`** missing | Add `PassRole` for the task/exec roles (doc 02) — most common miss |
| Force deploy AccessDenied | `ecs:UpdateService` / `ecs:cluster` condition | Doc 02 `EcsDescribeAndDeployServices` |
| 404 `ecs_service_not_found` | Catalog `serviceName`/`clusterName` wrong | Verify against live (doc 03) |
| Deploy reaches `running` then 504 `ecs_not_stable` after ~5 min | New task fails to start/stay healthy (image, health check, capacity, secrets) | Not IAM — inspect the ECS service events + task stopped-reason |
| Wrong container updated / sidecar changed | `containerName` mismatch | Set `containerName` to the exact task-def container |
| Login POST returns HTML/404 behind a custom domain | Web `API_BASE` path mismatch | Rebuild web with `VITE_API_BASE` matching the mount path (doc 04) |
| Deploy record stuck `running` forever | Async worker never ran (self-invoke IAM) **or** worker erroring | Check `lambda:InvokeFunction` self-grant + Lambda logs; `MaximumRetryAttempts:0` means no auto-retry |

---

## Go-live checklist

**Infra & access**
- [ ] Region is `ap-south-1` everywhere (stack, ECR URIs, artifact bucket).
- [ ] Heimdall Lambda IAM scoped per doc 02, including **`iam:PassRole`** for task/exec roles.
- [ ] `SERVICE_CATALOG=sandbox` **removed**; `AWS_INTEGRATION=aws`, `DATA_STORE=dynamodb` set.
- [ ] Async settings present: `Timeout 360`, `EventInvokeConfig MaximumRetryAttempts 0`, self-invoke permission.

**Catalog**
- [ ] All 13 services verified against live ECS/ECR (doc 03 loop passes, all `ACTIVE`).
- [ ] `admin_app` stage tag stays `staging`; all preprod tags are `preprod`.
- [ ] `githubRepository` placeholders replaced.

**App repos**
- [ ] OIDC provider created once; per-repo push roles deployed (immutable-ID `sub` handled).
- [ ] Each repo's CI pushes `sha-<sha>`; none push env pointer tags.

**Heimdall control plane**
- [ ] Stack deployed; `/health` OK; UI lists 13 services + 4 envs.
- [ ] Seed admin password rotated after first login; real users created.
- [ ] Secrets (`JwtSecret`, admin password) sourced from Secrets Manager/SSM, not committed.

**End-to-end proof (per the sandbox validation, now on real infra)**
- [ ] One service: CI push → **dev** deploy → verify → promote **stage** → **preprod** (admin) → **prod** (admin), all `succeeded`.
- [ ] A rollback on dev succeeds.
- [ ] A `user`-role account is correctly blocked from preprod/prod.

---

## What was already proven in the sandbox

The full pipeline — GitHub push → Actions CI (OIDC) → ECR → Heimdall UI deploy → async 202 +
polling → ECS force-deploy + wait-stable → live traffic — was validated end-to-end across all
four environments, including the async fix (no UI hang) and RBAC. SkillBrew go-live re-runs that
same proven flow against the real clusters; nothing about the mechanism changes, only the
catalog values, IAM scoping, and region.
