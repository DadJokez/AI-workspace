# Production deployment

Comparative deploys merged `main` commits through the `ai-workspace-build`
CodeBuild project. The pipeline is fail-closed and uses the same commit-SHA
tag for the ECS and AgentCore images.

## Ordered deployment path

After migrations and image pushes, `infra/scripts/deploy-ecs-stack.sh` performs
the ECS handoff in this order:

1. `cdk deploy AiWorkspaceEcsStack --require-approval never --exclusively`
   reconciles the checked-in stack with CloudFormation.
2. CodeBuild forces new deployments of `ai-workspace-web`,
   `ai-workspace-chat-worker`, and `ai-workspace-memory-worker` so every service
   pulls the images that were just pushed.
3. `aws ecs wait services-stable` blocks until all three services stabilize.
4. The build log records a JSON receipt containing the commit SHA and each
   service's live task-definition ARN.
5. The authenticated production smoke runs against the stable services.

CDK is the change detector. For an image-only commit it reports no stack
changes and immediately continues to the ECS refresh. For a task-definition,
environment, IAM, load balancer, or other `AiWorkspaceEcsStack` change, CDK
applies and waits for the CloudFormation update before the image refresh can
begin. A failed CDK update or unstable ECS service stops the build before smoke.

The CodeBuild service role may assume only the account-and-region-specific CDK
bootstrap deploy and file-publishing roles. The publisher is limited to the
bootstrap asset bucket and key used for large synthesized templates.
CloudFormation continues to apply stack changes through the bootstrap execution
role; CodeBuild does not receive direct broad CloudFormation or IAM
permissions.

AgentCore remains a separate stack and is updated immediately before this ECS
handoff by `infra/scripts/update-agentcore-stack.sh`.

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

The script preserves every other source setting returned by CodeBuild, changes
only `gitCloneDepth`, and verifies the saved value. The project remains
console-managed until #467 brings the full pipeline into infrastructure as
code. Until then, rerun this deterministic reconciler after replacing or
manually editing the project.

The classifier still fails closed to a full deployment when either SHA is
missing or invalid, a commit cannot be resolved, or the changed paths are
ambiguous. An unavailable previous commit can waste a deployment, but can
never incorrectly skip one.

## One-time bootstrap

The first rollout of this deployment path must be applied by an operator from
the reviewed commit because the previous CodeBuild role cannot grant itself
permission to assume the CDK bootstrap roles. Run a scoped `cdk diff` and deploy
`AiWorkspaceEcsStack` once. That deployment adds the two exact
`sts:AssumeRole` resources managed by this stack. All subsequent merged commits
use the normal CodeBuild path; do not leave a separate hand-written IAM policy
behind.

## Verification

The deployment receipt is the source for the exact task-definition revisions
that served a commit. The final authenticated smoke must pass before the
CodeBuild deployment is considered healthy. Unit tests use fake CDK and AWS
commands to enforce the ordering and fail-closed behavior without changing
production.

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
`latest` is only the parameter default for manual deploys. The ECR repositories
allow mutable tags, so this is traceable by deployment convention rather than
registry-enforced immutability; digest pinning would be required for that.
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
