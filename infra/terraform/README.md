# Terraform

Infrastructure for Comparative, built beside the CDK app in `infra/cdk/` until the cutover. Design and
order: [`docs/roadmap/KOCH_FIREWALL_PLAN.md`](../../docs/roadmap/KOCH_FIREWALL_PLAN.md) §4 and
[`docs/roadmap/KOCH_MIGRATION_SPEC.md`](../../docs/roadmap/KOCH_MIGRATION_SPEC.md) Part B.

Nothing here is applied by a pull request. A human applies `bootstrap/`, `00-foundation` and, as things
stand, `20-data` (see "What the apply role cannot do" below); the pipeline (later work packages) applies
the other stacks.

## Layout

```
versions.tf.tmpl     canonical versions.tf; every stacks/*/versions.tf is a byte-for-byte copy
tf.sh                the one way to run a stack
check.sh             static checks, the same commands CI runs
bootstrap/           one-time per account: state bucket and its KMS key
modules/ci-identity/ GitHub OIDC provider, plan/apply/image-push/evals roles, workload boundary
modules/network/     VPC (built or adopted), endpoints, security groups, optional stand-in proxy
stacks/00-foundation/ KMS keys, ECR repositories, the ci-identity module, SSM outputs
modules/data/        database, optional RDS Proxy, secrets, buckets
stacks/10-network/   the network module, SSM outputs
stacks/20-data/      the data module, SSM outputs
envs/<env>/          backend.hcl, env.tfvars, release.auto.tfvars
policy/              Conftest rules and their fixtures
```

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
`REPLACE_ME`.

Every stack reads the same `env.tfvars`; Terraform prints a warning for values a stack does not declare.
Stacks do not read each other's state: a stack publishes what others need to SSM Parameter Store under
`/comparative/<env>/<stack>/<key>`.

## First run (human, per account)

These commands change AWS. They are run by the account owner with administrator credentials, never by CI.

1. In `envs/personal-stage/env.tfvars`, replace the `REPLACE_ME` values for `account_id`, `tags`,
   `github_*` and `eval_model_ids`. The numeric GitHub ids come from
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
  (`ECC_NIST_P256`, `SIGN_VERIFY`) for release images.
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
  workload needs something it does not allow.
- SSM parameters `kms/data_arn`, `kms/logs_arn`, `kms/secrets_arn`, `ecr/app_repo_url`,
  `ecr/agent_repo_url` under `/comparative/<env>/00-foundation/`.

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

## Checks

```bash
infra/terraform/check.sh             # fmt, versions, validate, lint, test, policy
infra/terraform/check.sh policy      # one step
```

Needs `terraform`, `tflint`, `conftest` and `jq`. No credentials, no state, no AWS calls.

The `test` step runs `terraform test` in every module and then the module's own scripts,
`modules/<module>/tests/*.sh`. There is one: `modules/data/tests/no_secret_in_plan.sh` plans
`modules/data/tests/plan` for real (placeholder credentials, empty state, nothing contacted), reads the
plan as JSON and fails if a secret value is in it or would reach the state. Given a path, it checks
that plan JSON instead: `no_secret_in_plan.sh plan.json`.
`.github/workflows/terraform-ci.yml` runs the same steps plus a Checkov config scan.

### Policy rules

Conftest rules over `terraform show -json` output. Each rule has `policy/fixtures/<rule>/pass.json`,
`fail.json` and `fail.expected.txt`; `check.sh policy` requires the failing fixture to produce exactly
the expected messages, all carrying the rule's id.

| Rule | Rejects |
|---|---|
| `ecs-no-public-ip` | an ECS service with `assign_public_ip = true` |
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
