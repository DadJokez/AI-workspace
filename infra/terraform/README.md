# Terraform

Infrastructure for Comparative, built beside the CDK app in `infra/cdk/` until the cutover. Design and
order: [`docs/roadmap/KOCH_FIREWALL_PLAN.md`](../../docs/roadmap/KOCH_FIREWALL_PLAN.md) §4 and
[`docs/roadmap/KOCH_MIGRATION_SPEC.md`](../../docs/roadmap/KOCH_MIGRATION_SPEC.md) Part B.

Nothing here is applied by a pull request. A human applies `bootstrap/`, `00-foundation` and, as things
stand, `20-data` and `30-platform` (see the two sections "What the apply role cannot do" below); the
pipeline applies the other stacks when a change merges (see "Plan, apply, promote").

## Layout

```
versions.tf.tmpl     canonical versions.tf; every stacks/*/versions.tf is a byte-for-byte copy
tf.sh                the one way to run a stack
check.sh             static checks, the same commands CI runs
plan_checks.sh       helper of the stack tests: reads what a stack plans inside its modules
bootstrap/           one-time per account: state bucket and its KMS key
modules/ci-identity/ GitHub OIDC provider, plan/apply/image-push/evals roles, workload boundary
modules/network/     VPC (built or adopted), endpoints, security groups, optional stand-in proxy
modules/data/        database, optional RDS Proxy, secrets, buckets
modules/ecs-task/    one Fargate task definition with its log group and two roles
modules/ecs-service/ ecs-task plus the service, optional Cloud Map name and autoscaling
modules/agentcore/   AgentCore runtime, web-search credential provider, Studio Browser, their roles
modules/observability/ ops alert topic, alarms, log metric filters, dashboard
stacks/00-foundation/ KMS keys, ECR repositories, the ci-identity module, SSM outputs
stacks/10-network/   the network module, SSM outputs
stacks/20-data/      the data module, SSM outputs
stacks/30-platform/  ECS cluster, private namespace, load balancer, SSM outputs
stacks/35-deploy-tasks/ migrator and smoke task definitions, SSM outputs
stacks/40-services/  the four services, SSM outputs
stacks/50-agentcore/ the agentcore module, SSM outputs
stacks/60-observability/ the observability module, SSM outputs
envs/<env>/          backend.hcl, env.tfvars, release.auto.tfvars
                     (personal-stage; personal-rehearsal, the firewall rehearsal's)
policy/              Conftest rules and their fixtures
scripts/             what the plan and apply workflows run, each with its fixtures (*.test.sh)
```

Apply order for a new environment: `00-foundation`, `10-network`, `20-data`, `30-platform`,
`35-deploy-tasks`, `50-agentcore`, `40-services`, `60-observability`. `40-services` cannot be planned
until `50-agentcore` has been applied (see "What 40-services creates"), and `60-observability` reads
what `40-services` publishes.

Versions: Terraform `~> 1.17`, AWS provider `~> 6.73`. `modules/data` also needs `hashicorp/random`
`~> 3.7` for its ephemeral password; the module declares that itself, so `versions.tf.tmpl` is unchanged
and only `stacks/20-data` locks it. `.terraform.lock.hcl` is committed for `linux_amd64`, `linux_arm64`
and `darwin_arm64`. After changing a provider version, regenerate it in each root module (`stacks/*`,
`bootstrap`):

```bash
terraform providers lock -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_arm64
```

## Running a stack

```bash
infra/terraform/tf.sh <env> <stack> <plan|apply|destroy|output> [extra args]
```

`tf.sh` runs `terraform init -reconfigure` against `envs/<env>/backend.hcl` with the state key
`<env>/<stack>.tfstate`, then the command with `envs/<env>/env.tfvars` and
`envs/<env>/release.auto.tfvars`. It refuses to run while a value in `envs/<env>/` still contains
`REPLACE_ME`. `tf.sh <env> <stack> apply <plan file>` applies a plan saved with `plan -out=<plan file>`
(an absolute path) as it is, without the variable files, which Terraform refuses next to a saved plan.

Every stack reads the same `env.tfvars`; Terraform prints a warning for values a stack does not declare.
Stacks do not read each other's state: a stack publishes what others need to SSM Parameter Store under
`/comparative/<env>/<stack>/<key>`.

## First run (human, per account)

These commands change AWS. They are run by the account owner with administrator credentials, never by CI.

1. In `envs/personal-stage/env.tfvars`, replace the `REPLACE_ME` values for `account_id`, `tags`,
   `github_*` and `eval_model_ids`, and those under the `30-platform`, `40-services` and
   `60-observability` headings (`domain_name`, `certificate_arn`, `invite_email_*`, `bedrock_model_ids`,
   `alert_emails`, the quota in `quota_alarm_models`): `tf.sh` runs no stack while one remains. The numeric GitHub ids come from
   `gh api repos/<owner>/<repo> --jq '{repository_id: .id, owner_id: .owner.id}'`.
2. Create the state bucket and its key with local state, then move that state into the bucket:

   ```bash
   cd infra/terraform/bootstrap
   printf 'terraform {\n  backend "local" {}\n}\n' > backend_override.tf   # git-ignored
   terraform init
   terraform apply -var-file=../envs/personal-stage/env.tfvars
   terraform output
   ```

   Copy `state_bucket_name` and `state_kms_key_arn` from the output into
   `envs/personal-stage/backend.hcl` (`bucket`, `kms_key_id`) and `envs/personal-stage/env.tfvars`
   (`state_bucket_name`, `state_kms_key_arn`). Then:

   ```bash
   rm backend_override.tf
   terraform init -migrate-state \
     -backend-config=../envs/personal-stage/backend.hcl \
     -backend-config="key=bootstrap/terraform.tfstate"
   rm -f terraform.tfstate terraform.tfstate.backup
   cd ..
   ```

3. Plan, read the plan, apply:

   ```bash
   ./tf.sh personal-stage 00-foundation plan
   ./tf.sh personal-stage 00-foundation apply
   ./tf.sh personal-stage 00-foundation output
   ```

   The output lists the role ARNs and the signing key ARN that later workflows need as GitHub variables.

The apply role trusts the GitHub environment named after the Terraform environment (`personal-stage`).
That GitHub environment, and its protection rules, are created in the repository settings.

## What 00-foundation creates

- KMS keys `data`, `logs`, `secrets` (rotation on) and an asymmetric `signing` key
  (`ECC_NIST_P256`, `SIGN_VERIFY`) for release images. The policy of the `logs` key lets CloudWatch
  Logs use it for the log groups under `/comparative/<env>/`, and CloudWatch alarms for the topic
  `<name_prefix>-ops-alerts` of `60-observability`.
- ECR repositories `<name_prefix>-app` and `<name_prefix>-agent`: immutable tags, scan on push, KMS
  encryption, lifecycle (untagged images expire after 7 days; the last 60 images are kept per release
  tag prefix `web-`, `worker-`, `memory-worker-`, `migrator-`, `agent-`).
- CI roles, all assumed through GitHub OIDC with the audience, repository name and both numeric
  repository ids pinned:

  | Role | Who can assume it | What it can do |
  |---|---|---|
  | `<name_prefix>-tf-plan` | any ref of the repository | `ReadOnlyAccess`, read of this environment's state; denied secret values, S3 object contents outside its state, and log contents |
  | `<name_prefix>-tf-apply` | the GitHub environment `<env>` only | manage the services stacks 10 to 60 use; IAM only under `/comparative/<env>/` and only with the workload boundary; secret metadata, never values |
  | `<name_prefix>-image-push` | `refs/heads/main` only | push to the two repositories, sign with the signing key |
  | `<name_prefix>-evals` | the nightly eval workflow on `main`, the product-smoke workflow on a pull-request merge ref | `bedrock:InvokeModelWithResponseStream` on the listed models |

- `<name_prefix>-workload-boundary`: the permissions boundary every role under `/comparative/<env>/`
  must carry. Later stacks set it on each role they create and extend it, in `00-foundation`, when a
  workload needs something it does not allow. It was extended once that way: `ses:SendEmail` from this
  account's identities, for the web service's invitation email.
- SSM parameters `kms/data_arn`, `kms/logs_arn`, `kms/secrets_arn`, `ecr/app_repo_url`,
  `ecr/agent_repo_url` and `iam/workload_boundary_arn` under `/comparative/<env>/00-foundation/`. Every
  stack that creates a role reads the boundary from the last one.

Two properties to keep:

- **The apply role cannot apply `00-foundation`.** It holds no IAM permission on the CI roles, the
  boundary or the OIDC provider, and can use but not administer the KMS keys. A merged change can
  therefore never widen the pipeline's own access; changes to this stack are applied by a human.
- **The plan role cannot take the state lock.** It can read state but not write the lock file, so a plan
  run with it passes `-lock=false`.

`manage_account_singletons` is true in exactly one environment per account. That environment owns the
per-account resources: the evals role, and the GitHub OIDC provider once `create_oidc_provider` is true.
While another owner holds the provider (today the CDK eval stack), it is looked up instead.

## What 10-network creates

Applied after `00-foundation` (it reads the logs key from SSM):

```bash
./tf.sh personal-stage 10-network plan
./tf.sh personal-stage 10-network apply
```

`network_mode` chooses between a VPC built here and one a landing zone supplies; `firewall_mode` and
`egress` move together.

| | `create`, `egress = "nat"` (sandbox) | `create`, `egress = "proxy"` (rehearsal) | `adopt` |
|---|---|---|---|
| VPC, subnets, routes, flow logs | built: a /16 with one /20 app and one /20 data subnet per zone | built, as left | supplied: `vpc_id`, `app_subnet_ids`, `data_subnet_ids`, `public_subnet_ids` |
| Public subnets | one per zone | none when `internal_alb` is true | supplied when the load balancer is public |
| Way out of the app subnets | default route to one NAT gateway | none: the proxy and the endpoints only | the landing zone's routing |
| S3 gateway endpoint | yes | yes | the landing zone's |
| Interface endpoints | none | one per entry of `interface_endpoints`, private DNS on | as left, in the supplied app subnets |
| Security groups and rules | yes | yes | yes |

- **Zones.** A VPC built here uses the first `az_count` zones of `agentcore_az_ids` (zone ids, not
  names), so every app subnet can carry the AgentCore Browser. In adopt mode `agentcore_subnet_ids` is
  the supplied app subnets that lie in one of those zones.
- **Security groups.** `alb`, `web`, `worker`, `browser_proxy`, `studio_browser`, `agent_runtime`,
  `deploy_task`, `db`, plus `endpoints` in firewall mode. Every rule is its own
  `aws_vpc_security_group_*_rule` resource, declared in `modules/network/security_groups.tf`; a rule
  between two groups is written once and becomes the egress rule of one and the ingress rule of the
  other. Only the load balancer takes ingress from address ranges (`alb_ingress_cidrs`), and
  `0.0.0.0/0` is refused there unless `internal_alb` is false.
- **Proxy.** With `egress = "proxy"`, exactly one of two things is set. `proxy_url` with `proxy_cidrs`
  names the organisation's proxy; the groups that use it may reach its port in those ranges only.
  `create_standin_proxy` builds a stand-in for a rehearsal: one Fargate task running squid (a public
  image pinned by digest) that lets through the hosts in `proxy_allowlist` and nothing else, logs every
  request to `/comparative/<env>/standin-proxy`, sits in the one subnet that has a NAT route, and is
  reachable only from the groups that use a proxy. Its private DNS namespace needs Route 53
  permissions the apply role holds only with `manage_public_edge`.
- **Published to SSM** under `/comparative/<env>/10-network/`: `vpc_id`, `app_subnet_ids`,
  `data_subnet_ids`, `public_subnet_ids`, `agentcore_subnet_ids`, `sg/<group>_id` for the eight
  workload groups, `proxy_url`, `no_proxy`. SSM cannot hold an empty value, so the subnet lists are
  JSON arrays (read them with `jsondecode`; an empty list is `[]`) and `proxy_url` is the word `none`
  when there is no proxy.
- **`no_proxy`** is the private DNS names of the interface endpoints, the regional S3 names (S3 goes
  through the gateway endpoint), `.<region>.elb.amazonaws.com` (which covers an internal load
  balancer's own name; a custom internal DNS name is not covered), `169.254.170.2`, `localhost`,
  `127.0.0.1` and the VPC resolver's address.

## What 20-data creates

Applied after `10-network` (it reads the data subnets, the database security group and two KMS keys from
SSM):

```bash
./tf.sh personal-stage 20-data plan
./tf.sh personal-stage 20-data apply
./tf.sh personal-stage 20-data output
```

- **Database.** `<name_prefix>-db`: PostgreSQL 16 on gp3, 20 GB growing to `db_max_allocated_storage`,
  encrypted with the data key, in the data subnets with the `db` security group, never public. Deletion
  protection is on, and deleting the instance leaves the snapshot `<name_prefix>-db-final`. Automated
  backups are kept `db_backup_days`; Performance Insights is on with the 7-day retention that carries
  no charge. The parameter group sets `rds.force_ssl = 1` and `log_min_duration_statement`.
- **Master password.** RDS creates and rotates it in a secret of its own, encrypted with the secrets
  key. Terraform never sees it; the stack outputs that secret's ARN.
- **Restore.** `db_restore_snapshot_id` seeds a new instance from a snapshot and is ignored afterwards.
  Set it before the first apply, with `db_name` and `db_master_username` equal to the snapshot's: both
  are fixed when the instance is created, and a different value plans a replacement.
- **RDS Proxy.** Off. `enable_rds_proxy = true` adds a proxy that requires TLS, its role under
  `/comparative/<env>/` with the workload boundary, the two rules that let it reach the instance inside
  the `db` group, and one more secret shell, `comparative/<env>/db-proxy-auth`
  (`{"username": "...", "password": "..."}` of the database login the proxy connects with). The stack
  outputs `db_proxy_endpoint`; `db/endpoint` in SSM stays the instance.
- **Secrets**, all encrypted with the secrets key, each with a resource policy that refuses every other
  account:

  | Secret | Value |
  |---|---|
  | `comparative/<env>/app` | none from Terraform; a human writes it (fields below) |
  | `comparative/<env>/browser-proxy-db` | none from Terraform; a human writes `{"DATABASE_URL": "..."}` |
  | `comparative/<env>/browser-proxy` | generated: `{"username": "comparative-browser", "password": "<48 letters and digits>"}` |

  The generated password comes from an ephemeral resource and is sent through a write-only argument, so
  it is in neither the plan nor the state. To rotate it, raise `secret_string_wo_version` in
  `modules/data/secrets.tf`, apply, and restart the web and browser-proxy services.
- **Buckets.** `<name_prefix>-alb-logs-<account>-<region>`: S3-managed encryption (the only kind load
  balancer log delivery supports), objects expire after 30 days, and a policy that lets this account's
  load balancers in this region write under `AWSLogs/<account>/`. The load balancer is therefore
  configured with this bucket and **no prefix**. `<name_prefix>-artifacts-<account>-<region>`:
  encrypted with the data key, versioned, unused for now. Both block all public access.
- **Published to SSM** under `/comparative/<env>/20-data/`: `db/endpoint` (the instance's host name,
  without the port), `db/port`, `db/instance_id`, `secret/app_arn`, `secret/browser_proxy_arn`,
  `secret/browser_proxy_db_arn`, `bucket/alb_logs`, `bucket/artifacts`.
- **Disposable data.** `data_disposable = true`, for an environment that is created and destroyed
  whole (only `personal-rehearsal`), turns off what keeps data through a destroy: deletion protection
  and the final snapshot of the instance, the 30-day recovery window of the secrets (their names would
  stay taken), and the refusal to delete a bucket that holds objects. It is false everywhere else.

### What the apply role cannot do

`<name_prefix>-tf-apply` holds secret metadata permissions on `comparative/<env>/*` only. This stack
needs more in three places, so a human with administrator credentials applies it until the role is
extended in `00-foundation`, which is the owner's decision:

- writing the browser-proxy value (`secretsmanager:PutSecretValue`) and, on every later plan or apply,
  finding that version again (`secretsmanager:ListSecretVersionIds`);
- letting RDS create the master secret, which RDS names itself, outside `comparative/<env>/`;
- changing a secret's description or key (`secretsmanager:UpdateSecret`).

### After the first apply of 20-data

The database has one login, the master user, and two of the three secrets are empty. Services cannot
start until these steps are done. The account owner runs them; they change AWS and the database.

The application does not use the master user. It gets a role of its own that owns the database. That
role needs `CREATEROLE`: migration `0050_web_egress_policy_reader` issues `CREATE ROLE`, and PostgreSQL
refuses that statement to a role without the right even when the role already exists. The egress proxy gets
`web_egress_policy_reader`, the role that migration defines: created here with a password so that it
can log in, and granted its three columns by the migration when the migrator first runs.

1. Open a shell that can reach the database: in an app subnet, with the `deploy_task` security group,
   under your own identity (for example an AWS CloudShell VPC environment), with `aws`, `jq` and `psql`.
   A task role under `/comparative/<env>/` cannot do this: the workload boundary does not cover the
   master secret.

   ```bash
   ENV_NAME=personal-stage
   DB_NAME=comparative        # db_name in env.tfvars
   DB_HOST=$(aws ssm get-parameter --name /comparative/$ENV_NAME/20-data/db/endpoint \
     --query Parameter.Value --output text)
   ```

2. Generate the two passwords and create the roles as the master user. The master secret's ARN is the
   stack output `db_master_user_secret_arn`.

   ```bash
   MASTER=$(aws secretsmanager get-secret-value --secret-id "<db_master_user_secret_arn>" \
     --query SecretString --output text)
   new_password() {
     aws secretsmanager get-random-password --password-length 40 --exclude-punctuation \
       --query RandomPassword --output text
   }
   APP_PASSWORD=$(new_password)
   READER_PASSWORD=$(new_password)

   PGPASSWORD=$(jq -r .password <<<"$MASTER") psql \
     "host=$DB_HOST port=5432 dbname=$DB_NAME user=$(jq -r .username <<<"$MASTER") sslmode=require" \
     -v ON_ERROR_STOP=1 -v app_password="$APP_PASSWORD" -v reader_password="$READER_PASSWORD" <<'SQL'
   CREATE ROLE comparative_app LOGIN CREATEROLE PASSWORD :'app_password';
   GRANT comparative_app TO CURRENT_USER;
   ALTER DATABASE :"DBNAME" OWNER TO comparative_app;
   CREATE ROLE web_egress_policy_reader LOGIN PASSWORD :'reader_password';
   SQL
   ```

3. Write the two secrets. `app-secret.json` is a file you fill in with the fields listed below; delete
   it afterwards.

   ```bash
   # The DATABASE_URL field of app-secret.json:
   echo "postgresql://comparative_app:$APP_PASSWORD@$DB_HOST:5432/$DB_NAME?sslmode=require"

   aws secretsmanager put-secret-value --secret-id comparative/$ENV_NAME/app \
     --secret-string file://app-secret.json

   aws secretsmanager put-secret-value --secret-id comparative/$ENV_NAME/browser-proxy-db \
     --secret-string "$(jq -n --arg url \
       "postgresql://web_egress_policy_reader:$READER_PASSWORD@$DB_HOST:5432/$DB_NAME?sslmode=require" \
       '{DATABASE_URL: $url}')"

   rm -f app-secret.json
   unset MASTER APP_PASSWORD READER_PASSWORD
   ```

A database restored from a snapshot already has its roles. Step 2 is then `ALTER ROLE ... PASSWORD` for
the two roles, and whichever role `DATABASE_URL` names must be able to run the migrations.

### Fields of the app secret

`comparative/<env>/app` is one JSON object of string values. The services read each field by name, and a
task whose definition names a missing field does not start, so every field of the first list is present
even when its feature is unused (an empty string is a value).

Always present, sixteen fields:

```
DATABASE_URL
NEXTAUTH_SECRET
GITHUB_AUTH_CLIENT_ID
GITHUB_AUTH_CLIENT_SECRET
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
NOTION_CLIENT_ID
NOTION_CLIENT_SECRET
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
SALESFORCE_CLIENT_ID
SALESFORCE_CLIENT_SECRET
OAUTH_ENCRYPTION_KEY
WEB_SEARCH_PROVIDER
BRAVE_SEARCH_API_KEY
GITHUB_WEBHOOK_SECRET
```

The first fifteen go to the web service and both workers, `GITHUB_WEBHOOK_SECRET` to the web service
only. They are the names production uses today (`infra/cdk/lib/ai-workspace-ecs-stack.ts`:
`APP_SECRET_FIELDS` and the web container's secrets).

Present only when the feature is on:

```
OIDC_CLIENT_SECRET       when the pingone sign-in provider is enabled
POSTHOG_PROJECT_TOKEN    when ANALYTICS_PROVIDER is posthog
```

A field of the second list reaches the web service only when it is also named in
`optional_app_secret_fields` (`env.tfvars`, read by `40-services`).

## What 30-platform creates

Applied after `20-data` (it reads the VPC, the subnets and the `alb` security group from `10-network` and
the access-log bucket from `20-data`):

```bash
./tf.sh personal-stage 30-platform plan
./tf.sh personal-stage 30-platform apply
./tf.sh personal-stage 30-platform output
```

- **Cluster.** `<name_prefix>-cluster`. Container Insights is off; `container_insights = true` turns it
  on.
- **Namespace.** The Cloud Map private DNS namespace `internal_namespace` in the environment's VPC.
  Services that register a name are reached as `<service>.<namespace>`.
- **Load balancer.** `<name_prefix>-alb`: public in the public subnets, or with `internal_alb = true`
  internal in the app subnets. It drops invalid header fields, writes access logs to the bucket of
  `20-data` (no prefix), and is protected against deletion when `alb_deletion_protection` is true.
  - HTTPS on 443 with the policy `ELBSecurityPolicy-TLS13-1-2-2021-06`, forwarding to the web target
    group.
  - HTTP on 80 answering with a 301 to HTTPS, on a public load balancer only.
  - Target group `<name_prefix>-web`: task IPs on HTTP 3000; health check `/api/health` expecting 200
    every 30 s with a 10 s timeout, 2 successes to be healthy and 3 failures to be unhealthy; 30 s of
    draining.
- **Certificate and DNS.** One of two ways:
  - `certificate_arn` names an existing ACM certificate for `domain_name`. DNS stays with its owner: the
    stack outputs `alb_dns_name` for the record that must point at the load balancer.
  - `route53_zone_id` names the hosted zone of `domain_name`. The stack then creates the alias record
    and, when `certificate_arn` is not set, requests the certificate and validates it through the zone.
- **WAF.** `waf_acl_arn` associates an existing regional web ACL with the load balancer.
- **Published to SSM** under `/comparative/<env>/30-platform/`: `cluster_arn`, `cluster_name`,
  `namespace_id`, `alb_arn`, `alb_dns_name`, `alb_arn_suffix`, `tg/web_arn`, `tg/web_arn_suffix`,
  `base_url` (`https://<domain_name>`).

### What the apply role cannot do

Cloud Map creates a private hosted zone for the namespace, and Route 53 authorises that against the
caller. `<name_prefix>-tf-apply` holds Route 53 permissions only with `manage_public_edge = true`, which
also grants ACM and WAF. Until the owner decides between turning that on and giving the role a narrower
Route 53 statement in `00-foundation`, a human with administrator credentials applies this stack. The
same holds for `route53_zone_id` and `waf_acl_arn`, by design: those need `manage_public_edge`.

## What 35-deploy-tasks creates

Applied after `30-platform` (it reads the base URL from it, the app secret from `20-data` and two keys
and the boundary from `00-foundation`), and again with every release:

```bash
./tf.sh personal-stage 35-deploy-tasks plan
./tf.sh personal-stage 35-deploy-tasks apply
```

Two task definitions without a service, each with a log group and its two roles:

| Task | Image | Command | Receives |
|---|---|---|---|
| `<name_prefix>-migrator` | `image_migrator` | the image's own | secret `DATABASE_URL` |
| `<name_prefix>-smoke` | `image_worker` | `pnpm --filter @ai-workspace/web smoke:prod:auth` | `SMOKE_BASE_URL` (`internal_base_url` when set, otherwise the base URL of `30-platform`), `SMOKE_RUN_ID` (`release_id`); secrets `DATABASE_URL`, `NEXTAUTH_SECRET` |

Neither task role has any AWS permission. The pipeline runs each with `ecs run-task` in the app subnets
with the `deploy_task` security group (both published by `10-network`), using the ARN published here.

**Published to SSM** under `/comparative/<env>/35-deploy-tasks/`: `taskdef/migrator_arn`,
`taskdef/smoke_arn` and `snapshot_keep_days`. Each ARN carries its revision, so both change with every
release. `snapshot_keep_days` (from `env.tfvars`) is how long the apply workflow keeps the
`pre-migrate-*` database snapshots it takes before a release's migrations.

## What 50-agentcore creates

Applied after `35-deploy-tasks` and before `40-services` (it reads the agentcore subnets, two security
groups and the proxy from `10-network`, two secrets from `20-data`, and the secrets key and the boundary
from `00-foundation`), and again with every release:

```bash
./tf.sh personal-stage 50-agentcore plan
./tf.sh personal-stage 50-agentcore apply
```

- **Runtime.** `<name_prefix>_agent` with dashes as underscores (AgentCore names allow no dash), running
  `image_agent` (linux/arm64, by digest) over HTTP. `agentcore_network_mode` is `PUBLIC` in the sandbox,
  as production's runtime is today, or `VPC`: the runtime then sits in `agentcore_subnet_ids` with the
  `agent_runtime` security group, and receives `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` when
  `10-network` publishes a proxy. A `PUBLIC` runtime is outside the VPC and gets no proxy. Its environment
  is otherwise `BEDROCK_CLIENT=real`, `AWS_DEFAULT_REGION`, `WEB_SEARCH_PROVIDER`,
  `BEDROCK_INFERENCE_PROFILE_PREFIX`, and `BRAVE_SEARCH_CREDENTIAL_PROVIDER` with web search on. A release
  changes only the container image.
- **No endpoint resource.** The chat worker invokes the runtime's `DEFAULT` endpoint: the application
  sends a qualifier only when `AGENTCORE_QUALIFIER` is set, and no service sets it. AgentCore keeps
  `DEFAULT` on the latest version.
- **Runtime role** `<name_prefix>-agent-runtime`, under `/comparative/<env>/` with the workload
  boundary, assumable by AgentCore for this account and region only: pull from the agent repository,
  invoke the models of `bedrock_model_ids` (the same ARNs as the services of `40-services`, never `*`),
  write logs under `/aws/bedrock-agentcore/`. With web search, also `bedrock-agentcore:GetResourceApiKey`
  on the default workload identity directory, the runtime's own workload identity, the default token
  vault and the one credential provider. Unlike the CDK runtime role it has no `aws-marketplace` grant,
  which the boundary does not allow either.
- **Web search.** `agentcore_web_search_provider = "brave"` creates the API key credential provider
  `<name_prefix>-brave-search` pointing at the field `BRAVE_SEARCH_API_KEY` of `comparative/<env>/app`;
  Terraform never reads the key. `"none"` creates neither the provider nor the permission, and the agent
  offers no web search tool. Keep it in step with `WEB_SEARCH_PROVIDER` of the services.
- **Studio Browser** `<name_prefix>_studio_browser`, with request signing on, as production's. With
  `agentcore_browser_network_mode = "VPC"` (as production's) it sits in `agentcore_subnet_ids` with the
  `studio_browser` security group, which reaches only the browser proxy and DNS; `PUBLIC` leaves only the
  session's proxy setting between the browser and the internet. Its execution role
  `<name_prefix>-studio-browser` may read `comparative/<env>/browser-proxy` and nothing else.
- **Logs.** AgentCore creates the runtime's log groups under `/aws/bedrock-agentcore/runtimes/` itself,
  as it does today: they are not under `/comparative/<env>/`, so the logs key does not encrypt them and
  this stack sets no retention on them.
- **Published to SSM** under `/comparative/<env>/50-agentcore/`: `runtime_arn`, `browser_id`,
  `browser_arn`.

### Not yet proven against AWS

The configuration plans; none of it has been applied. These are open until a human has applied the
stack in a scratch environment (migration spec, WP-13 step 1):

- that the runtime reaches READY in `VPC` mode with the arm64 image, reaches Bedrock, the AgentCore data
  plane, ECR and CloudWatch Logs through the interface endpoints alone, and the MCP facades through the
  internal load balancer; whether it needs network-interface permissions of its own (none are granted;
  AgentCore is expected to use its service-linked role);
- that a new `image_agent` updates the runtime in place and creates a new version that `DEFAULT`
  follows;
- that the browser works in `VPC` mode in the zones of `agentcore_az_ids` with signing on;
- that the credential provider reads the key from the app secret, which is encrypted with the secrets
  key, and with whose permission. If AgentCore reads it as the caller, the apply role (denied
  `secretsmanager:GetSecretValue`) cannot create the provider and a human applies this stack; if as the
  runtime role, that role needs read of a secret that holds every application secret, which is the
  owner's decision and is not granted here;
- that Bedrock accepts the runtime role's model calls without an `aws-marketplace` grant.

## What 40-services creates

Applied after `50-agentcore`, and again with every release:

```bash
./tf.sh personal-stage 40-services plan
./tf.sh personal-stage 40-services apply
```

It reads `runtime_arn`, `browser_id` and `browser_arn` from `/comparative/<env>/50-agentcore/`. Until
`50-agentcore` has been applied in the environment, this one fails at plan with a missing-parameter
error. There is no switch to run without them.

| Service | Image | Command | CPU / memory | Tasks | Network |
|---|---|---|---|---|---|
| `web` | `image_web` | the image's own | 512 / 1024 | `web_min` to `web_max`, scaling at 60 % CPU (60 s out, 300 s in) | port 3000 behind the web target group; `web` security group |
| `chat-worker` | `image_worker` | `pnpm --filter @ai-workspace/web worker:chat-runs` | 256 / 512 | `chat_worker_count` | `worker` security group |
| `memory-worker` | `image_memory_worker` | `pnpm --filter @ai-workspace/web worker:memory-capture` | 256 / 512 | 1 | `worker` security group |
| `browser-proxy` | `image_worker` | `pnpm --filter @ai-workspace/web browser:egress-proxy` | 256 / 512 | 1 | port 3128, `browser-proxy.<namespace>`, TCP container health check; `browser_proxy` security group |

Every service runs in the app subnets without a public IP, rolls a failed deployment back, and makes an
apply wait until it is steady. The two workers may drop to no healthy task during a deployment; the
other two keep 100 %. Autoscaling owns the number of web tasks: Terraform sets it once, at `web_min`.

- **Environment.** Web and both workers get the common set (`NODE_ENV`, `AWS_REGION`, `BEDROCK_CLIENT`,
  `RUNTIME`, `RUNTIME_V2_ENABLED`, `RUNTIME_V2_DIRECT_MODEL_ID`, `NEXTAUTH_URL`,
  `LEGACY_HOST_REDIRECT_FROM`, `HOSTNAME`, `PORT`, `BEDROCK_INFERENCE_PROFILE_PREFIX`),
  `INTERNAL_BASE_URL` when `internal_base_url` is set, `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` when
  `10-network` publishes a proxy, then `extra_environment`, then what the service sets for itself. A
  later value replaces an earlier one, so `extra_environment` cannot change a service's own settings.
  `extra_environment` is where the switches of the configuration contract go (`WEB_SEARCH_PROVIDER`,
  `ENABLED_CONNECTOR_PROVIDERS`, `AUTH_PROVIDERS`, ...). The browser proxy gets `NODE_ENV`,
  `AWS_REGION` and `BROWSER_PROXY_PORT` only.
- **Secrets.** Always a reference (`<secret ARN>:<field>::`), never a value. Web and both workers read
  the first fifteen fields of the app secret (see "Fields of the app secret"); web also reads
  `GITHUB_WEBHOOK_SECRET` and the fields named in `optional_app_secret_fields`. The browser proxy reads
  `DATABASE_URL` from `comparative/<env>/browser-proxy-db` and its user name and password from
  `comparative/<env>/browser-proxy`, and never the app secret.
- **Permissions.** Web, chat-worker and memory-worker may invoke the models in `bedrock_model_ids`:
  the inference profile `<bedrock_inference_profile_prefix><id>` in the home region and the foundation
  model in each region of `bedrock_inference_regions`, as a list of ARNs without a wildcard. Web and
  chat-worker may invoke the AgentCore runtime. Web may also send email from `invite_email_identity`,
  run sessions on the AgentCore Browser, and read the browser-proxy credentials those sessions use.
  The browser proxy has no AWS permission.
- **Published to SSM** under `/comparative/<env>/40-services/`: `service/web_name`,
  `service/chat_worker_name`, `service/memory_worker_name`, `service/browser_proxy_name`,
  `log_group/chat_worker_name`, `log_group/memory_worker_name`.

The apply role may need Route 53 permissions here too: the browser proxy's Cloud Map service is created
in the private namespace. See "What the apply role cannot do" under `30-platform`.

## What 60-observability creates

Applied last (it reads the logs key from `00-foundation`, the cluster and the load balancer from
`30-platform`, and the service names and two log groups from `40-services`):

```bash
./tf.sh personal-stage 60-observability plan
./tf.sh personal-stage 60-observability apply
```

- **Topic.** `<name_prefix>-ops-alerts`, encrypted with the logs key, with one email subscription per
  address in `alert_emails`. AWS sends each address a confirmation email; nothing is delivered to it
  until its owner confirms, and Terraform cannot confirm for them.
- **Alarms**, each `<name_prefix>-<alarm>`, each notifying the topic when it fires and when it clears.
  The values are the ones production runs with (`infra/cdk/lib/ai-workspace-ecs-stack.ts` and
  `infra/scripts/setup-ops-alarms.sh`):

  | Alarm | Metric | Fires when | Missing data |
  |---|---|---|---|
  | `web-below-task-floor` | `AWS/ECS` `LiveTaskCount`, minimum, web service | below `web_min` for 3 of 3 minutes | breaching |
  | `browser-proxy-unavailable` | same, browser-proxy service | below 1 for 3 of 3 minutes | breaching |
  | `chat-worker-no-running-tasks` | same, chat-worker service | below 1 for 3 of 3 minutes | breaching |
  | `memory-worker-no-running-tasks` | same, memory-worker service | below 1 for 3 of 3 minutes | breaching |
  | `web-unhealthy-hosts` | `AWS/ApplicationELB` `UnHealthyHostCount`, maximum, web target group | at least 1 for 3 of 3 minutes | not breaching |
  | `web-5xx` | `HTTPCode_Target_5XX_Count`, sum, web target group | at least 5 in 5 minutes | not breaching |
  | `load-balancer-5xx` | `HTTPCode_ELB_5XX_Count`, sum, load balancer | at least 5 in 5 minutes | not breaching |
  | `memory-capture-failures` | `MemoryCaptureFailures`, sum | at least 1 in 20 minutes | not breaching |
  | `run-failure-burst` | `RunFailedCount`, sum | at least 3 in 15 minutes | not breaching |
  | `bedrock-<model>-token-headroom` | `AWS/Bedrock`: input + cache-write + `output_burndown` x output tokens, summed over a rolling day | at least 80 % of `daily_quota` | not breaching |

- **Log metric filters**, both writing to the namespace `Comparative/<env>/Workers` (the environment is
  in the namespace because a log-derived metric has no dimensions):
  - `memory-capture-failures` on the memory worker's log group: `MemoryCaptureFailures` counts lines
    with `memory-capture-error` or `memory-capture-worker-fatal`.
  - `run-failed-events` on the chat worker's log group: `RunFailedCount` counts lines with
    `[chat-run-worker-error]`.
- **Quota alarms.** One per entry of `quota_alarm_models`. A Bedrock quota and the `AWS/Bedrock`
  metrics belong to the account, not the environment: list the models in one environment per account
  and set `quota_alarm_models = []` in the others. Check each `daily_quota` against Service Quotas
  before the first apply.
- **Dashboard.** `<name_prefix>-ops`: the metric of every alarm, with the alarm's statistic and
  period, and per watched model the quota expression against its threshold.
- **Published to SSM** under `/comparative/<env>/60-observability/`: `sns/ops_topic_arn`.

There is no queue-depth alarm: the application publishes no metric for it yet.

After the first apply, confirm each subscription, then prove that an alarm reaches a person. The topic
is encrypted, and an alarm that may not use the key fails to notify without any error:

```bash
aws cloudwatch set-alarm-state --alarm-name cmp-personal-stage-run-failure-burst \
  --state-value ALARM --state-reason "delivery test"
```

The alarm returns to its real state at its next evaluation. If no email arrives, read the alarm's
history (`aws cloudwatch describe-alarm-history`) for a failed action, and the statement
`CloudWatchAlarmsToOpsTopic` of the logs key in `00-foundation`.

## A release

`envs/<env>/release.auto.tfvars` holds `release_id` and the five images of a release, each by digest
(`<account>.dkr.ecr.<region>.amazonaws.com/<repository>@sha256:<digest>`; a tag is refused). A deploy
changes that file and nothing else, then applies `35-deploy-tasks`, `50-agentcore` and `40-services`.
In `40-services` such a change touches task definitions and services only: a new revision of each task
definition is registered, each service moves to it, and the previous revision is deregistered after the
service is steady.

### How a release is made

`.github/workflows/build-release.yml` runs on every push to `main` that can change an image (not on
documentation, and not on the merge of a release itself). It assumes `<name_prefix>-image-push` and, for
each of `web`, `worker`, `memory-worker`, `migrator` (amd64, repository `<name_prefix>-app`) and `agent`
(arm64, repository `<name_prefix>-agent`):

1. builds the image and pushes it as `<component>-<commit sha>`, the tag prefixes the lifecycle rules of
   `00-foundation` keep. A re-run of the same commit finds the tag and reuses its digest;
2. writes an SBOM (SPDX JSON) of the pushed digest and scans the digest. A critical or high
   vulnerability that has a fix fails the image unless `.github/release-vulnerability-allowlist.yaml`
   exempts it, and an exemption ends on its `expired_at` date;
3. attaches the SBOM to the digest as a signed attestation and signs the digest, both with the `signing`
   key. A signature therefore also says that the digest passed the scan. It carries the annotations
   `release_id` and `component`, and no transparency log is used: verification needs the key alone,

   ```bash
   cosign verify --key awskms:///<signing_key_arn> --insecure-ignore-tlog=true \
     -a release_id=<commit sha> -a component=web <repository>@sha256:<digest>
   ```

Signatures and attestations are stored as OCI referrers of the digest, not under tags of their own
(cosign 3 writes no `sha256-<digest>.sig` tag), so the lifecycle policy has no rule for them: ECR is
documented to remove the referrers of an image when it expires the image. This was not exercised
against ECR when the workflow was written. After the first release, confirm it once:

```bash
aws ecr list-images --repository-name <name_prefix>-app --filter tagStatus=TAGGED   # only <component>-<sha> tags
aws ecr start-lifecycle-policy-preview --repository-name <name_prefix>-app
aws ecr get-lifecycle-policy-preview --repository-name <name_prefix>-app            # no signature or SBOM of a kept image
```

If the first command lists a `sha256-…` tag, the registry did not accept the referrers and cosign fell
back to a tag, which an immutable repository refuses to update. If the preview selects referrers of an
image that is kept, the untagged rule would delete signatures after 7 days. Either result means the
lifecycle policy in `stacks/00-foundation/main.tf` has to change before releases are relied on.

The last job writes `release.json` and `release.auto.tfvars` (artifact `release-personal-stage`) and
opens or updates the pull request `release(personal-stage): <short sha>` from the branch
`release/personal-stage`, whose only change is the release file. `.github/workflows/release-checks.yml`
then verifies on that pull request that it changes nothing else and that every digest is signed for a
commit on `main`. That check is evidence for the reviewer; the pull request still needs every required
check.

One-time setup, in the repository settings:

| Kind | Name | Value |
|---|---|---|
| Variable | `RELEASE_AWS_REGION` | `aws_region` of the environment |
| Variable | `RELEASE_IMAGE_PUSH_ROLE_ARN` | output `image_push_role_arn` of `00-foundation` |
| Variable | `RELEASE_SIGNING_KEY_ARN` | output `signing_key_arn` |
| Variable | `RELEASE_APP_REPOSITORY_URL` | SSM parameter `ecr/app_repo_url` |
| Variable | `RELEASE_AGENT_REPOSITORY_URL` | SSM parameter `ecr/agent_repo_url` |
| Variable | `RELEASE_VERIFY_ROLE_ARN` | output `tf_plan_role_arn` (read-only; verifies signatures on the release pull request) |
| Variable | `RELEASE_BOT_CLIENT_ID` | client id of the GitHub App that opens the release pull request |
| Secret | `RELEASE_BOT_PRIVATE_KEY` | a private key of that App |

These are repository variables, not variables of a GitHub environment: a job that names an environment
presents a different OIDC subject, which the image-push role refuses. `RELEASE_BASE_IMAGE_REGISTRY` and
`RELEASE_PNPM_REGISTRY` are optional mirrors for the image builds.

The GitHub App is installed on this repository only, with the repository permissions Contents and Pull
requests (read and write). The pull request is opened with its installation token because GitHub starts
no workflow for a pull request opened with the workflow's own `GITHUB_TOKEN`, and the required checks
would then never report. Until the App exists, leave `RELEASE_BOT_CLIENT_ID` unset: the workflow stops
after uploading the artifact and a human opens the pull request from it.

## Plan, apply, promote

Three workflows move a change from a pull request to an environment. Until the cutover (WP-20) they
deploy `personal-stage` only; production stays on CodeBuild.

### Plan on pull request

`.github/workflows/terraform-plan.yml` runs on every pull request that touches `infra/terraform/**`.
`scripts/affected.sh` decides which (environment, stack) pairs the change affects:

| Change | Pairs |
|---|---|
| `envs/<e>/release.auto.tfvars` | `<e>` × `35-deploy-tasks`, `50-agentcore`, `40-services` |
| anything else under `envs/<e>/` | `<e>` × every stack |
| `stacks/<s>/**` | every environment × `<s>` |
| `modules/<m>/**` | every environment × every stack that uses `<m>`, directly or through another module |
| `tf.sh`, `scripts/placeholders.sh` | every pair |
| documentation, checks, `policy/`, the other scripts, `bootstrap/` | none |

For each pair it assumes `<name_prefix>-tf-plan` and runs `scripts/stack.sh plan`: `tf.sh … plan
-lock=false -out` (the plan role may not write the state lock), `terraform show -json`, the Conftest rules
of `policy/`, and `scripts/plan-report.sh`. A plan fails when a rule rejects it, or when it destroys or
replaces an `aws_db_instance`, `aws_kms_key`, `aws_s3_bucket`, `aws_secretsmanager_secret` or
`aws_ecr_repository`, unless a human has labelled the pull request `allow-stateful-replace`
(`scripts/stateful-replace-allowed.sh`: the label counts only if its last application was by a human,
because the review bot can add labels too). Rob applies that label, then re-runs the failed job.

One comment per environment, updated in place, lists each stack with its totals and a table of adds,
changes, replacements and destroys by resource type: no values and no addresses, because a `for_each` key
can be a configuration value (an alert email address, for one). An environment that still has
`REPLACE_ME` values is not planned, and its comment says so.

A plan that passed every check is uploaded as the artifact `tfplan-<env>-<stack>-<head sha>` (the plan
file and `report.json` with its fingerprint), kept 30 days. The job `apply role refuses pull requests`
asks STS for each apply role with the pull request's OIDC token and passes only when STS refuses: that is
the standing proof that a pull request cannot assume the apply role.

### Apply on merge

`.github/workflows/terraform-apply.yml` runs on every push to `main` that touches `infra/terraform/**`,
one job per affected environment, in the GitHub environment of that name (the subject the apply role
trusts) and one at a time per environment (`tf-apply-<env>`, never cancelled). Each job:

1. refuses a commit that does not descend from the last commit deployed successfully to the environment,
   so re-running an old run cannot roll a newer release back;
2. for a change that is not only a release, downloads the reviewed plans of the merged pull request (by
   its head sha, from `terraform-plan.yml` runs only) and checks `allow-stateful-replace` with `main`'s
   copy of the script;
3. with the read-only plan role: for a release, verifies that every digest in the release file is
   signed for its release id and that the id is on `main` (`release-tfvars.sh signed`); for a stack a
   human applies (`00-foundation`, `20-data`, `30-platform`), checks that nothing is pending. If something
   is, the job stops before applying anything: apply that stack by hand, together with the affected stacks
   before it in the apply order, then re-run the job;
4. with the apply role, applies the stacks in the apply order with `scripts/stack.sh apply`: plan with
   the state lock, Conftest, then `tf.sh … apply <saved plan>`. A plan that changes nothing is not
   applied. Any other plan of a stack the merged change touched outside the release file must have the
   fingerprint of the reviewed plan; a plan that destroys or replaces a stateful resource must also be
   the reviewed one, with the label. Otherwise the job fails: open a pull request that shows the plan as
   it is now. A stack only the release touched (`35-deploy-tasks`, `50-agentcore`, `40-services`) is
   applied on the strength of the signatures;
5. for a release, around those applies: after `35-deploy-tasks`, `scripts/snapshot-db.sh` when
   `packages/db/drizzle` changed since the release last deployed successfully (snapshot
   `pre-migrate-<sha12>-<run>-<attempt>` of `20-data/db/instance_id`, waited for and checked, and the
   `pre-migrate-*` snapshots of that instance older than `snapshot_keep_days` deleted), then
   `scripts/run-task.sh <env> migrator`; after `50-agentcore` and `40-services`,
   `scripts/run-task.sh <env> smoke`. Both tasks run on Fargate in the app subnets with the `deploy_task`
   security group and no public IP, everything read from SSM, and must exit 0. When the smoke task
   fails, the job opens a pull request that reverts the merged commit (with the release bot; without it,
   the job summary says what to revert) and fails. Nothing merges it automatically;
6. records a GitHub deployment of the commit (task `terraform-apply`, success or failure) whose payload
   holds the release id, the five images, each stack's plan fingerprint and whether it was applied, the
   snapshot id, and the migrator and smoke task ARNs with their exit codes; the job summary shows the
   same JSON. Its environment URL is the base URL of `30-platform`.

GitHub keeps one pending run per concurrency group, so when a third run queues behind a running one, the
second is cancelled and its changes are applied by no run; drift detection (WP-16) reports them.

Rolling back is a revert of the release pull request: the previous digests are signed for a commit on
`main`, so the revert deploys like any release. Migrations are expand-only, so the database stays.

### Promotion

`.github/workflows/promote.yml` (run by hand on `main`, inputs `from` and `to`) checks that the latest
deployment of `from` for the release id in its file succeeded with exactly those images, writes
`envs/<to>/release.auto.tfvars` with the same id and digests (`release-tfvars.sh promote`), and opens the
pull request `promote(<to>): <short sha> from <from>` from `release/<to>`, which `release-checks.yml`
verifies like a release. When `envs/<to>/env.tfvars` sets `production = true`, it first dispatches
Product Smoke with `run_evals=true` against `from`'s base URL on a temporary branch
`promote-eval/<release id>` at the release commit, waits for it, and requires its eval and public smoke
jobs to pass.

### Settings (Rob)

| Kind | Name | Value |
|---|---|---|
| Variable | `TF_ROLE_ARNS` | `{"personal-stage": {"plan": "<tf_plan_role_arn>", "apply": "<tf_apply_role_arn>"}}`, outputs of `00-foundation` |
| Environment | `personal-stage` | no required reviewer; deployment branches: `main` only |
| Environment | `personal-prod` (WP-20) | required reviewer Rob; deployment branches: `main` only |
| Label | `allow-stateful-replace` | applied by Rob only |
| Branch protection | Require review from Code Owners | so that `.github/CODEOWNERS` (`envs/*-prod/`, `modules/ci-identity/`) takes effect |

`RELEASE_SIGNING_KEY_ARN`, `RELEASE_BOT_CLIENT_ID` and `RELEASE_BOT_PRIVATE_KEY` are the ones of "How a
release is made".

The pipeline needs the filled-in files of `envs/<env>/` committed: an environment with `REPLACE_ME` values
is neither planned nor applied.

Two things the workflows rely on that are not true yet:

- **The eval gate of a production promotion.** `AWS_EVAL_ROLE_ARN` (today the CDK eval role, later the
  `evals` role of `modules/ci-identity`) trusts Product Smoke on pull requests and Nightly Evals on `main`,
  not a dispatched Product Smoke run, so the gate fails closed. Its trust needs a statement for the
  workflow `Product Smoke` on `ref:refs/heads/promote-eval/*`; that is an IAM decision.
- **Production verifying stage's signatures.** Images are signed once, with the signing key of the
  environment that built them. Promoting them to an environment in another account, or with its own key,
  needs that environment's plan role to read the building environment's key and registry. WP-20 settles
  this for `personal-prod`.

## Firewall rehearsal

`envs/personal-rehearsal` is the firewall profile in the personal account, created for a rehearsal and
destroyed after it (migration spec, WP-19; firewall plan, step 4). `scripts/rehearsal.sh` stands it up,
runs the checks from inside the VPC, reports what left the VPC and how, and tears it down. The pipeline
never plans or applies it: its committed files carry placeholders, and `terraform-apply.yml` deploys
`personal-stage` only.

| | `personal-rehearsal` |
|---|---|
| Network | built here, `firewall_mode = true`, `egress = "proxy"`: no internet route from the app subnets, the interface endpoints of `10-network` for AWS |
| Proxy | the stand-in (`create_standin_proxy = true`): squid allowing `proxy_allowlist` and nothing else, logging every request |
| Load balancer | internal (`internal_alb = true`), reachable from the VPC's range only |
| AgentCore | runtime and Studio Browser in the VPC (`agentcore_network_mode = "VPC"`), web search off |
| Switches | `ENABLED_CONNECTOR_PROVIDERS=salesforce,github`, `ANALYTICS_PROVIDER=none`, `GITHUB_EVENT_INGEST_MODE=poll`, `WEB_FETCH_ENABLED=0`; `WEB_SEARCH_PROVIDER=none` in the app secret |
| `INTERNAL_BASE_URL` | `https://<the internal load balancer's DNS name>`, written by `up` |
| Sizes | two zones (the least a load balancer and a DB subnet group accept), database in one (`db_multi_az = false`), `db.t4g.micro`, one task of each service, one day of backups |
| Data | a new, empty database; `data_disposable = true` so that `down` removes everything |

`WEB_FETCH_ENABLED=0` is not part of the spec's switch set: the URL fetch tool reaches any public host,
which an allowlisting proxy cannot express, so the inventory would put `*` on the proxy list. Whether
Koch allows any host through its proxy is the open egress answer.

### The allowlist

`proxy_allowlist` in `env.tfvars` is generated, never edited: `rehearsal.sh allowlist` runs
`pnpm egress:inventory --allowlist` (`apps/web/lib/egress-inventory.ts`) with this environment's settings
(its `extra_environment`, region, email provider, web search, AgentCore runtime and browser, an internal
URL) and nothing of the caller's own environment, turns `*.example.com` into squid's `.example.com`,
drops a host such a domain covers, and rewrites the block between the `BEGIN` and `END` markers.
`rehearsal.sh allowlist --check` fails while the block differs from the inventory; it needs the
application's dependencies (`pnpm install`), so it runs where they are installed, not in Terraform CI.
`scripts/fixtures/rehearsal/egress-allowlist.json` is the inventory's output the committed block was
generated from; `rehearsal.test.sh` checks the block against it.

### Running a rehearsal (Rob)

Every command below changes AWS. Run them with administrator credentials for the personal account,
from a machine with `aws`, `terraform`, `conftest` and `jq`.

1. On that machine only, fill in the `REPLACE_ME` values of `envs/personal-rehearsal/env.tfvars` and
   `backend.hcl` (mostly personal-stage's values; `domain_name` needs an ACM certificate in the region,
   `invite_email_*` a verified SES identity), and copy the release to rehearse:
   `cp envs/personal-stage/release.auto.tfvars envs/personal-rehearsal/`. Keep these copies off `main`.
2. `scripts/rehearsal.sh up`. It applies `00-foundation`, `10-network` and `20-data`, then stops (exit
   3) until the app secret and the browser-proxy database secret have values: do "After the first apply
   of 20-data" with `ENV_NAME=personal-rehearsal`, with `WEB_SEARCH_PROVIDER` set to `none` in the app
   secret, and run `up` again. It then applies `30-platform`, writes `internal_base_url`, applies
   `35-deploy-tasks`, runs the migrator, and applies `50-agentcore`, `40-services` and
   `60-observability`. Each stack goes through `stack.sh apply` (plan, Conftest, apply of that plan).
3. `REHEARSAL_EMAIL=<address> scripts/rehearsal.sh run`. The address is the one the magic-link check
   asks a sign-in link for; in the SES sandbox it must be verified.
4. `scripts/rehearsal.sh report`, at least ten minutes after `run` ended (flow logs arrive in
   aggregation windows of up to ten minutes). It writes `docs/security/FIREWALL_REHEARSAL_<date>.md`.
5. `scripts/rehearsal.sh down`. Terraform asks to confirm each stack's destroy. The state bucket is not a
   stack and stays, with this environment's (empty) state files. The KMS keys of `00-foundation` are
   scheduled for deletion after their 30-day window; AgentCore's own log groups under
   `/aws/bedrock-agentcore/` are not Terraform's and stay.

The report goes into a docs pull request, and every failure in it becomes an issue.

### The checks

`run` starts each check as an ECS task from the smoke task definition of `35-deploy-tasks` (worker image,
app subnets, `deploy_task` security group, no public IP) with `run-task.sh`, which takes the overrides in
`TASK_OVERRIDES`.

| Check | How |
|---|---|
| Magic-link request; SES leaves through the proxy | `node` posts to `/api/auth/signin/email` on the internal URL; `report` requires an allowed request to `email.<region>.amazonaws.com` in the proxy log. Run first, while the users table is empty and any address may ask for a link |
| Authenticated smoke | the task as it is: `smoke:prod:auth` against `SMOKE_BASE_URL` (the internal URL); it includes a durable AgentCore run |
| Eval gate | `pnpm eval --gate` with `BEDROCK_CLIENT=real`, as the chat-worker's task role (Bedrock through the endpoint). The harness calls Bedrock itself; it takes no URL |
| Durable AgentCore run with an MCP facade tool call, scheduled run, event trigger in poll mode, Studio Browser start and stop | **not run**: the application has no entry point that runs them inside the VPC. They are reported as not run, and the report's result is at best INCOMPLETE |

`report` lists, for the run window: each check's result; every host requested at the stand-in proxy,
allowed or denied, and whether `proxy_allowlist` has it; every REJECT in the flow logs from an app
subnet; every flow from an app subnet to an address outside the VPC that is not S3's (the gateway
endpoint), which is a connection that ignored the proxy; and the hosts the inventory lists that nothing
used. The result is FAIL with any failed check, denied host or direct connection, INCOMPLETE with a
check not run, and PASS otherwise. No account id or network interface id is written.

### The dry run

`rehearsal.sh --plan-only` is the acceptance check, run by `check.sh rehearsal` in Terraform CI. It needs
no credentials. For each stack, in the apply order, it copies the stack and the modules to a temporary
directory and runs `terraform test` with one plan run (`scripts/fixtures/rehearsal/<stack>.tftest.hcl`)
against a mocked AWS provider, with `envs/personal-rehearsal/env.tfvars` and, in place of its
placeholders and of what `up` learns from AWS, `scripts/fixtures/rehearsal/plan-only.tfvars`. Each plan
then goes through the Conftest rules and `plan-report.sh`. It also prints the command of every check,
what `report` reads, and the destroy order.

What that does not prove, compared with a real `terraform plan`:

- Nothing is read from AWS. The fixtures stand in for what earlier stacks publish to SSM, for data
  sources (zones, the S3 prefix list) and for computed attributes. A real plan of a new environment is
  impossible anyway: each stack's SSM inputs exist only after the stacks before it are applied.
- The mocked provider does not merge `default_tags` into `tags_all`; the dry run does that merge itself
  before Conftest, as the provider would.
- `terraform test` gives a plan's resource changes but not its configuration, so the two rules that read
  the configuration (`encryption-at-rest` and `s3-block-public-access`, for a bucket's companion
  resources) see no buckets there. `modules/data`'s own tests cover those resources.
- Values known only after apply (ARNs in policies, for one) stay unknown, as in any first plan.

### Cost of a rehearsal day

From the WP-09 figures (interface endpoint about $7.30 per endpoint per zone per month; one NAT gateway
about $33 per month plus data), recomputed per day. The other lines are us-east-1 on-demand prices that
were not checked against the AWS price list when this was written (2026-11-19); check them before relying
on the total.

| Item | Per day |
|---|---|
| 15 interface endpoints × 2 zones | about $7.20 |
| NAT gateway of the stand-in proxy, and its public address | about $1.20, plus $0.045 per GB |
| Fargate: web (0.5 vCPU, 1 GB) and four 0.25 vCPU / 0.5 GB tasks (two workers, browser proxy, stand-in proxy) | about $1.80 |
| Internal load balancer | about $0.60 |
| `db.t4g.micro`, one zone, 20 GB gp3 | about $0.45 |
| KMS keys, secrets, logs and metrics | about $0.50 |
| **Total** | **about $12**, plus Bedrock tokens of the eval gate and the smoke, AgentCore usage and data processing |

The endpoints are three fifths of it, and they are billed by the hour: `down` on the same day as `up`
keeps a rehearsal near that figure.

### Looking at the UI (optional, not set up)

Nothing outside the VPC reaches the internal load balancer, and there is no bastion. A person can
forward a local port through a throwaway task with ECS Exec and Session Manager (the `ssmmessages`
endpoint exists in firewall mode). That needs a task role with the four `ssmmessages:` channel actions,
which no role has today (the workload boundary allows them); creating one is an IAM decision. With such a
role, and the Session Manager plugin installed locally:

```bash
aws ecs run-task --cluster <30-platform/cluster_arn> --launch-type FARGATE --enable-execute-command \
  --task-definition <35-deploy-tasks/taskdef/smoke_arn> \
  --network-configuration 'awsvpcConfiguration={subnets=[<app subnet ids>],securityGroups=[<sg/deploy_task_id>],assignPublicIp=DISABLED}' \
  --overrides '{"taskRoleArn": "<role with ssmmessages>", "containerOverrides": [{"name": "smoke", "command": ["sleep", "3600"]}]}'
aws ecs describe-tasks --cluster <cluster> --tasks <task arn> --query 'tasks[0].containers[0].runtimeId'
aws ssm start-session --target ecs:<cluster name>_<task id>_<runtime id> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host": ["<alb_dns_name>"], "portNumber": ["443"], "localPortNumber": ["8443"]}'
```

Then map `domain_name` to `127.0.0.1` in the local hosts file and open `https://<domain_name>:8443`; the
certificate is for that name. Stop the task afterwards.

## Checks

```bash
infra/terraform/check.sh             # fmt, versions, validate, lint, test, policy, scripts, rehearsal
infra/terraform/check.sh policy      # one step
```

Needs `terraform`, `tflint`, `conftest` and `jq`. No credentials, no state, no AWS calls.

The `test` step runs `terraform test` in every module and in every stack that has a `tests/` directory,
each followed by its own scripts, `tests/*.sh`:

- `modules/data/tests/no_secret_in_plan.sh` plans `modules/data/tests/plan` for real (placeholder
  credentials, empty state, nothing contacted), reads the plan as JSON and fails if a secret value is
  in it or would reach the state. Given a path, it checks that plan JSON instead:
  `no_secret_in_plan.sh plan.json`.
- `modules/observability/tests/policy_on_plan.sh` plans `modules/observability/tests/plan` the same
  way and runs every rule of `policy/` against that plan; it also requires the topic to carry a
  customer-managed key, which no rule covers.
- `modules/agentcore/tests/policy_on_plan.sh` plans `modules/agentcore/tests/plan` the same way and
  runs every rule of `policy/` against that plan; it also fails if the runtime role allows any
  `bedrock:` or `bedrock-agentcore:` action on `Resource: "*"` (`iam-bedrock-scope` covers only model
  invocation). `agentcore.tftest.hcl` asserts the same of the web-search policy, which a plan shows only
  after apply.
- `stacks/35-deploy-tasks/tests/deploy_tasks.sh`, `stacks/40-services/tests/services.sh`,
  `stacks/50-agentcore/tests/agentcore.sh` and `stacks/60-observability/tests/observability.sh` check
  what those stacks plan inside their modules, which a stack's test file cannot see. They run the stack's
  test file once more with `terraform test -json -verbose`, which prints every run's plan, and check
  those plans with `jq` through `plan_checks.sh`. `services.sh` and `agentcore.sh` are also the release
  tests: their first run applies against the mocked provider, the next plans with only the release's
  images changed, and the check fails if anything but a task definition or a service (in `50-agentcore`:
  the runtime) would change. Whether AWS updates the runtime in place is not something a mocked plan can
  show; see "Not yet proven against AWS".

A stack's tests supply what earlier stacks publish to SSM, so they need no state either.

The `scripts` step runs the fixtures of the pipeline's scripts, `scripts/*.test.sh`: `affected.sh`
(which pairs a change plans and applies), `plan-report.sh` (summary, stateful-replace detector and
fingerprint, against plan JSON in `scripts/fixtures/`), `stack.sh` (what an apply applies and refuses,
with a stand-in `terraform`), `rehearsal.sh` (every subcommand, with stand-ins for `terraform`,
`conftest`, `aws` and `pnpm`) and `stateful-replace-allowed.sh`. `run-task.sh` and `snapshot-db.sh`
call AWS; their tests are `apps/web/__tests__/terraform-run-task-script.test.ts` and
`terraform-snapshot-db-script.test.ts`, against a stubbed `aws`, in the unit suite.

The `rehearsal` step is the firewall rehearsal's dry run, `scripts/rehearsal.sh --plan-only` (see
"Firewall rehearsal").

`.github/workflows/terraform-ci.yml` runs the same steps plus a Checkov config scan.

### Policy rules

Conftest rules over `terraform show -json` output. Each rule has `policy/fixtures/<rule>/pass.json`,
`fail.json` and `fail.expected.txt`; `check.sh policy` requires the failing fixture to produce exactly
the expected messages, all carrying the rule's id.

| Rule | Rejects |
|---|---|
| `ecs-no-public-ip` | an ECS service with `assign_public_ip = true` |
| `ecs-image-by-digest` | an ECS task definition with a container whose image is not given by digest |
| `sg-no-open-ingress` | security-group ingress from `0.0.0.0/0` or `::/0` |
| `encryption-at-rest` | unencrypted RDS; a bucket without an encryption configuration; a log group, secret or ECR repository without a KMS key |
| `required-tags` | a taggable resource missing `app`, `env`, `owner`, `cost-center`, `data-class`, `managed-by` or `repo` |
| `iam-bedrock-scope` | an IAM policy allowing `bedrock:*` or `*`, or `bedrock:InvokeModel*` on `Resource: "*"` |
| `s3-block-public-access` | a bucket without a public access block, or a block with a setting off |
| `no-iam-users` | `aws_iam_user` and `aws_iam_access_key` |

Conventions the rules rely on:

- The only allowed open ingress is on the load balancer's security group when the root variable
  `internal_alb` is `false`. The rule recognises that group by its Terraform resource name, which must
  start with `alb` (`aws_security_group.alb`, `aws_vpc_security_group_ingress_rule.alb_https`).
- A bucket's encryption configuration and public access block are declared in the same module as the
  bucket and take their `bucket` argument from it.
- A policy document that is only known after apply cannot be read from a plan, so `iam-bedrock-scope`
  checks it on the next plan, not the first.

## Placeholders

`envs/personal-stage/` is committed with `REPLACE_ME` placeholders: this repository's Terraform code and
committed configuration carry no account id, domain or repository identity. Whether the filled-in files
are committed is the owner's decision.
