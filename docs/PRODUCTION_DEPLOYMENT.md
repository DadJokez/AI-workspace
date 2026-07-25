# Production deployment

Comparative deploys merged `main` commits through the `ai-workspace-build`
CodeBuild project. The pipeline is fail-closed and uses the same commit-SHA
tag for the ECS and AgentCore images.

## Ordered deployment path

For every non-docs-only build, CodeBuild performs the production handoff in
this order:

1. The x86 `ai-workspace-build` parent starts the dedicated
   `ai-workspace-agentcore-build` project at the exact resolved source commit.
   The CDK-owned child uses the native ARM64 CodeBuild image,
   `buildspec.agentcore.yml`, and no webhook or GitHub build status.
2. The parent builds the ECS images in parallel, then waits for the ARM child
   to finish successfully.
3. `infra/scripts/update-agentcore-stack.sh` synthesizes the current
   `AiWorkspaceAgentCoreSpikeStack` template and submits that template together
   with the commit-SHA image tag. It verifies the immutable ECR digest and
   records the source-template SHA-256 plus the monotonic CodeBuild sequence in
   the stack parameters.
4. The parent `ai-workspace-build` project is single-flight
   (`concurrentBuildLimit=1`), so an older build cannot deploy after a newer
   build. The dedicated child is independently single-flight, so the parent
   never consumes the only slot needed by its child. The recorded deployment
   sequence is a receipt and defense-in-depth check: it rejects an
   already-superseded build, but it is not itself an atomic lock.
5. `cdk deploy AiWorkspaceEcsStack --require-approval never --exclusively`
   reconciles the checked-in stack with CloudFormation.
6. The commit-SHA `ImageTag` parameter produces new task definitions, and the
   CloudFormation update rolls all three ECS services. There is no redundant
   second forced deployment.
7. `aws ecs wait services-stable` confirms all three services remain stable
   before the deployment receipt is recorded.
8. The build log records JSON receipts for AgentCore and ECS. The AgentCore
   receipt contains the commit SHA, image digest and tag, stack status,
   deployment sequence, and source-template SHA-256. The ECS receipt contains
   the commit SHA and each service's live task-definition ARN.
9. The authenticated production smoke runs against the stable services.

CDK is the change detector. Every non-docs deployment passes the resolved
commit SHA as `ImageTag`; a new SHA changes the task definitions and rolls the
services as part of the stack update. Re-deploying the identical SHA does not
recycle otherwise unchanged services. A failed CDK update or unstable ECS
service stops the build before smoke.

The CodeBuild service role may assume only the account-and-region-specific CDK
bootstrap deploy and file-publishing roles. The publisher is limited to the
bootstrap asset bucket and key used for large synthesized templates.
CloudFormation continues to apply stack changes through the bootstrap execution
role; CodeBuild does not receive direct broad CloudFormation or IAM
permissions.

AgentCore remains a separate stack. Its deploy script uses an inline synthesized
template so the existing stack-scoped `cloudformation:UpdateStack` permission is
sufficient; it fails explicitly if that template grows beyond CloudFormation's
51,200-byte inline limit. It never uses `--use-previous-template`, because that
would allow reviewed IAM, provider, logging, or runtime changes to remain
source-only while image updates appeared successful.

## CodeBuild source checkout

The docs-only classifier compares `CODEBUILD_WEBHOOK_PREV_COMMIT` with the
resolved `main` commit before any install, image build, migration, CDK, ECS, or
smoke work begins. The CodeBuild project must therefore retain full Git history
(`gitCloneDepth=0`), including the previous commit from multi-commit pushes.
Reconcile and verify that setting with:

```bash
AWS_DEFAULT_REGION=us-east-1 \
  ./infra/scripts/configure-codebuild-source.sh
```

Before changing the parent, the script verifies that
`ai-workspace-agentcore-build` exists and is the expected privileged ARM64
project with `buildspec.agentcore.yml`, no GitHub status reporting, no
artifacts, and `concurrentBuildLimit=1`. It then preserves every other parent
source setting returned by CodeBuild, sets `gitCloneDepth=0` and
`concurrentBuildLimit=1` together, and verifies both saved values. Any missing
or mismatched child or parent setting fails closed before the script reports
success.

The AgentCore child is owned by `AiWorkspaceAgentCoreSpikeStack`. The parent
project remains console-managed until #467 brings the full pipeline into
infrastructure as code. Until then, rerun this deterministic reconciler after
replacing or manually editing the parent.

The classifier still fails closed to a full deployment when either SHA is
missing or invalid, a commit cannot be resolved, or the changed paths are
ambiguous. An unavailable previous commit can waste a deployment, but can
never incorrectly skip one.

## One-time bootstrap

The ECS stack expects its ALB access-log bucket to exist before access logging
is enabled. The bucket remains outside the stack so CDK does not attempt to
adopt or replace the existing production bucket. Its reviewed, idempotent
bootstrap and repair path is:

```bash
AWS_DEFAULT_REGION=us-east-1 \
  ./infra/scripts/setup-alb-access-logs.sh
```

The script derives the account-specific default bucket name used by CDK,
blocks public access, enforces bucket ownership and SSE-S3 encryption, grants
only the account's ALB log-delivery path, and expires logs after 30 days. Run it
before the first ECS stack deployment in a new account or region and whenever
the bucket policy or lifecycle may have drifted. A custom
`ALB_ACCESS_LOG_BUCKET_NAME` must match the stack's
`aiWorkspace:albAccessLogBucketName` context value.

The AgentCore child and parent concurrency change must be rolled out in this
order:

1. From the reviewed commit, deploy `AiWorkspaceAgentCoreSpikeStack` with the
   live stack's current parameters. This creates
   `ai-workspace-agentcore-build` and grants the parent narrowly scoped
   `StartBuild`, `BatchGetBuilds`, and AgentCore ECR describe access.
2. Start the new child for that exact commit and wait for it to succeed.
3. Run `infra/scripts/configure-codebuild-source.sh`. Only now may the
   console-managed parent be changed to `concurrentBuildLimit=1`.
4. Verify both projects and then allow the normal merged-`main` deployment to
   exercise the complete handoff.

Never lower the parent concurrency before the child exists and succeeds: a
single-flight parent that targets itself cannot start its queued child build.
The reconciler checks this contract, and `agentcore-image-build.sh` also refuses
to target the project in which it is currently running.

The earlier ECS CDK-role bootstrap remains the same: when the parent role lacks
permission to assume the account-and-region-specific CDK bootstrap roles, an
operator must run the scoped `AiWorkspaceEcsStack` deployment once from the
reviewed commit. Do not leave a separate hand-written IAM policy behind.

## Verification

The deployment receipt is the source for the exact task-definition revisions
that served a commit. The final authenticated smoke must pass before the
CodeBuild deployment is considered healthy. Unit tests use fake CDK and AWS
commands to enforce the ordering and fail-closed behavior without changing
production.

Application Auto Scaling owns the web service's live desired count between its
two-task floor and four-task ceiling. The synthesized ECS service deliberately
omits `DesiredCount`, so a routine stack deployment does not reduce a service
that has scaled above the floor. On a new stack, ECS starts with its default
count and registering the scalable target brings it inside the configured
range.

The console-managed parent project must retain its single-flight setting.
Verify it after any CodeBuild project change:

```bash
aws codebuild batch-get-projects \
  --region us-east-1 \
  --names ai-workspace-build \
  --query 'projects[0].concurrentBuildLimit' \
  --output text
```

The expected value is `1`. The project is tracked for full infrastructure-as-code
ownership separately; until then, this setting is part of the production
deployment contract.

## Operations alarms

Apply or reconcile the production alarm set with an inbox that operators
actively monitor:

```bash
AWS_DEFAULT_REGION=us-east-1 OPS_ALERT_EMAIL=<ops-email> \
  ./infra/scripts/setup-ops-alarms.sh
```

The script is idempotent. It creates the SNS topic and requests an email
subscription only when the exact endpoint is absent; a rejected endpoint or an
unresolved load balancer stops the run instead of leaving a partially trusted
setup. Confirm the first subscription email before relying on notifications.

Worker liveness uses the standard `AWS/ECS` `LiveTaskCount` metric with the
cluster and service dimensions. `RunningTaskCount` belongs to the paid
Container Insights namespace and must not be substituted into `AWS/ECS`.
Application Load Balancer coverage includes target-generated 5xx responses,
load-balancer-generated 5xx responses, and unhealthy web targets. The
chat-worker log metric matches the emitted `[chat-run-worker-error]` marker.

## Rollback

Task definitions pin a commit-SHA tag (`ImageTag` stack parameter, #449), and
`latest` is only the parameter default for manual deploys.

**Image tags are mutable. Do not describe them as immutable.** Verified
2026-07-25 with `aws ecr describe-repositories`:

| Repository | `imageTagMutability` | `scanOnPush` |
|---|---|---|
| `ai-workspace` (web, worker, memory-worker) | `MUTABLE` | `false` |
| `ai-workspace-agentcore-agent` | `MUTABLE` | `true` |

Both buildspecs still push a floating `latest` alongside the commit-SHA tag
(`buildspec.yml` pushes `:latest`, `:worker-latest`, `:memory-worker-latest`;
`buildspec.agentcore.yml` pushes `:latest`). So a commit-SHA tag is unique by
*deployment convention*, and anyone with ECR push rights could repoint one.
What is genuinely immutable is the digest: `update-agentcore-stack.sh` resolves
the tag to a `sha256:` digest and records it in the deployment receipt, and
AgentCore pins the digest per runtime version. The ECS task definitions, by
contrast, reference the tag.

**Rob-gated follow-up:** setting `imageTagMutability=IMMUTABLE` on both
repositories, dropping the `latest` pushes, and pinning ECS task definitions to
digests would make this registry-enforced rather than conventional. That is an
infrastructure and deploy-contract change (it would break any manual
`:latest` deploy path) and belongs to Rob — tracked in #449. Enabling
`scanOnPush` on `ai-workspace` is the same conversation.

For an image-only regression, one command rolls all three services to a
previously built commit:

```bash
AWS_DEFAULT_REGION=us-east-1 ./infra/scripts/rollback-ecs.sh <good-commit-sha>
```

The script validates the tags exist in ECR, redeploys `AiWorkspaceEcsStack`
with `ImageTag=<sha>`, and waits for the services to stabilize. It does NOT
roll back database migrations — before rolling across a migration, confirm
the expand/contract rule holds (older code must run against the newer
schema); if it does not, revert the migration first.

For an infrastructure regression, revert the offending CDK change in source
and deploy `AiWorkspaceEcsStack` from that revision before refreshing ECS. Do
not patch task-definition environment values by hand: the next CDK deployment
would overwrite them and erase the rollback history. Use the before/after
deployment receipts to confirm that all intended task-definition revisions
changed together.
