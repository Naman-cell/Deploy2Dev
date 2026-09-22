# 03 — Service Catalog

The **service catalog** is how Heimdall knows which SkillBrew services exist and how each maps
to ECR + ECS per environment. It is the *only* place you "register" a service — there is no
GitHub connection. The catalog lives at
[`apps/api/src/service-catalog.json`](../../apps/api/src/service-catalog.json) and is bundled
into the Lambda at build time (you can also supply it at runtime — see the bottom of this doc).

**All 13 SkillBrew services are already in the catalog.** Your task is to (a) **verify** each
value against the live `ap-south-1` account, and (b) fill the `githubRepository` placeholders.

---

## The 13 services (as currently configured)

| serviceId | ECR repo | Container | Stage tag |
|-----------|----------|-----------|-----------|
| `django_app` | `skillbrew-be` | `django_app` | `stg` |
| `ai_interview` | `skillbrew_ai` | `ai_interview` | `stg` |
| `resume_analyzer` | `resume-analyzer` | `resume_analyzer` | `stg` |
| `skb_payment` | `skb-payments` | `skb_payment` | `stg` |
| `notification-api` | `notification-api` | `notification-api` | `stg` |
| `notification-worker` | `notification-worker` | `notification-worker` | `stg` |
| `skillbrew-agent` | `skillbrew-agent` | `skillbrew-agent` | `stg` |
| `skillbrew-agent-daemon` | `skillbrew-agent-daemon` | `skillbrew-agent-daemon` | `stg` |
| `skillbrew-reward` | `skillbrew-reward` | `skillbrew-reward` | `stg` |
| `public_app` | `skillbrew-fe` | `public_app` | `stg` |
| `developer_app` | `skillbrew-app-fe` | `developer_app` | `stg` |
| `organization_app` | `skillbrew-org-fe` | `organization_app` | `stg` |
| `admin_app` | `skillbrew-fe-admin` | `admin_app` | **`staging`** ⚠️ |

> ⚠️ **`admin_app` stage tag is `staging`, not `stg`.** This is a deliberate per-service
> override to match how that repo's CI already tags its stage image. Its **preprod** tag is
> still `preprod` (the `staging` quirk is stage-only). Don't "normalize" it.

---

## Anatomy of one catalog entry

```jsonc
{
  "serviceId": "django_app",                 // stable internal id (used in URLs/history)
  "name": "Django API",                       // display name in the UI
  "githubRepository": "Brudite-Pvt-Ltd/TODO-django_app",  // DISPLAY-ONLY metadata → fill this in
  "ecrRepository": "skillbrew-be",            // ECR repo NAME (used in DescribeImages/PutImage)
  "ecrRepositoryUri": "741005527903.dkr.ecr.ap-south-1.amazonaws.com/skillbrew-be",  // full URI (used to set the task-def image)
  "containerName": "django_app",              // which container in the task def to re-image
  "environments": {
    "dev":     { "clusterName": "skillbrew-dev-cluster",     "serviceName": "django_app", "taskFamily": "skillbrew-dev-django_app",     "environmentTag": "dev" },
    "stage":   { "clusterName": "skillbrew-staging-cluster", "serviceName": "django_app", "taskFamily": "skillbrew-staging-django_app", "environmentTag": "stg" },
    "preprod": { "clusterName": "skillbrew-staging-cluster", "serviceName": "django_app", "taskFamily": "skillbrew-staging-django_app", "environmentTag": "preprod" },
    "prod":    { "clusterName": "skillbrew-prod-cluster",    "serviceName": "django_app", "taskFamily": "skillbrew-prod-django_app",    "environmentTag": "prod" }
  },
  "allowedDeployRolesByEnvironment": {
    "dev":     ["admin", "user"],
    "stage":   ["admin", "user"],
    "preprod": ["admin"],
    "prod":    ["admin"]
  }
}
```

Field meanings:

- **`ecrRepository`** — passed to `DescribeImages`/`BatchGetImage`/`PutImage`. Must be the exact repo name.
- **`ecrRepositoryUri`** — used to build the new container image string `"<uri>:<environmentTag>"` when registering the task def (`aws-adapters.ts` L242).
- **`containerName`** — Heimdall only swaps the image of the container whose `name` matches this. Multi-container task defs keep their sidecars untouched. **Must match the task def exactly.**
- **`environments.<env>`** — the ECS coordinates + the ECR pointer tag for that env.
  - **`preprod` mirrors `stage`'s cluster/service/taskFamily** (shared infra) but with `environmentTag: "preprod"`.
- **`environmentTag`** — the pointer tag Heimdall moves on promote and sets in the task def. `dev` / `stg` / `preprod` / `prod` (except `admin_app` stage = `staging`).
- **`allowedDeployRolesByEnvironment`** — RBAC. Enforced server-side (`canDeploy` in `@heimdall/shared`) **and** in the UI. `preprod`/`prod` are admin-only for all services.

---

## Verify each value against the live account

Run these in `ap-south-1` (adjust names). Any mismatch → fix the catalog before go-live.

```bash
REGION=ap-south-1

# 1. ECR repo exists and holds images
aws ecr describe-repositories --region $REGION \
  --query "repositories[].repositoryName" --output text

# 2. Clusters exist
aws ecs list-clusters --region $REGION --query "clusterArns" --output text

# 3. For a service, confirm the ECS service name + its current task family + container name
aws ecs describe-services --region $REGION \
  --cluster skillbrew-dev-cluster --services django_app \
  --query "services[0].{name:serviceName,taskDef:taskDefinition,status:status}" --output json

# 4. Inspect the current task def to confirm containerName and the task/execution role ARNs
#    (the role ARNs feed the iam:PassRole grant in doc 02)
aws ecs describe-task-definition --region $REGION \
  --task-definition skillbrew-dev-django_app \
  --query "taskDefinition.{family:family,containers:containerDefinitions[].name,taskRole:taskRoleArn,execRole:executionRoleArn}" --output json
```

A quick loop to sanity-check every catalog entry's ECS service exists:

```bash
REGION=ap-south-1
python3 - <<'PY'
import json, subprocess
cat = json.load(open("apps/api/src/service-catalog.json"))
for s in cat:
    for env, e in s["environments"].items():
        out = subprocess.run(
            ["aws","ecs","describe-services","--region","ap-south-1",
             "--cluster",e["clusterName"],"--services",e["serviceName"],
             "--query","services[0].status","--output","text"],
            capture_output=True, text=True).stdout.strip()
        flag = "OK" if out == "ACTIVE" else "‼️  "+ (out or "MISSING")
        print(f"{s['serviceId']:24} {env:8} {e['clusterName']:24} {e['serviceName']:24} {flag}")
PY
```

---

## Fill in `githubRepository`

These are the `TODO-*` placeholders. They are **display-only** (shown in the UI so operators
know which repo a service comes from) — Heimdall does not use them to deploy. Replace e.g.
`Brudite-Pvt-Ltd/TODO-django_app` with the real repo slug `Brudite-Pvt-Ltd/skillbrew-backend`.

---

## Two ways to supply the catalog

The app resolves the catalog in this order (`apps/api/src/config.ts`):

1. **`SERVICE_CATALOG_JSON`** env var — inline JSON. Highest priority.
2. **`SERVICE_CATALOG_PATH`** env var — path to a JSON file.
3. **`SERVICE_CATALOG=sandbox`** — the single throwaway sample service. **Do not use in prod.**
4. **Bundled `service-catalog.json`** — the default; what ships in the Lambda zip.

**Recommended for SkillBrew:** edit the bundled `apps/api/src/service-catalog.json`, commit it,
and let it ride in the Lambda artifact (doc 04). Do **not** set `SERVICE_CATALOG=sandbox` in the
production stack (the sandbox template set it; the production deploy must omit or override it).

Proceed to [`04-deploy-heimdall.md`](./04-deploy-heimdall.md).
