# Terraform

Infrastructure for Comparative, built beside the CDK app in `infra/cdk/` until the cutover. Design and
order: [`docs/roadmap/KOCH_FIREWALL_PLAN.md`](../../docs/roadmap/KOCH_FIREWALL_PLAN.md) §4 and
[`docs/roadmap/KOCH_MIGRATION_SPEC.md`](../../docs/roadmap/KOCH_MIGRATION_SPEC.md) Part B.

Nothing here is applied by a pull request. A human applies `bootstrap/` and `00-foundation`; the
pipeline (later work packages) applies the other stacks.

## Layout

```
versions.tf.tmpl     canonical versions.tf; every stacks/*/versions.tf is a byte-for-byte copy
tf.sh                the one way to run a stack
check.sh             static checks, the same commands CI runs
bootstrap/           one-time per account: state bucket and its KMS key
modules/ci-identity/ GitHub OIDC provider, plan/apply/image-push/evals roles, workload boundary
stacks/00-foundation/ KMS keys, ECR repositories, the ci-identity module, SSM outputs
envs/<env>/          backend.hcl, env.tfvars, release.auto.tfvars
policy/              Conftest rules and their fixtures
```

Versions: Terraform `~> 1.17`, AWS provider `~> 6.73`. `.terraform.lock.hcl` is committed for
`linux_amd64`, `linux_arm64` and `darwin_arm64`. After changing the provider version, regenerate it in
each root module (`stacks/*`, `bootstrap`):

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

## Checks

```bash
infra/terraform/check.sh             # fmt, versions, validate, lint, test, policy
infra/terraform/check.sh policy      # one step
```

Needs `terraform`, `tflint`, `conftest` and `jq`. No credentials, no state, no AWS calls.
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
