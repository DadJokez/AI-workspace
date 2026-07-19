# Production deployment

Comparative deploys merged `main` commits through the `ai-workspace-build`
CodeBuild project. The pipeline is fail-closed and uses the same immutable
commit SHA for the ECS and AgentCore images.

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

## Rollback

Task definitions pin the immutable commit tag (`ImageTag` stack parameter,
#449) — what runs is exactly what a specific build pushed, and `latest` is
only the parameter default for manual deploys. For an image-only regression,
one command rolls all three services to a previously built commit:

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
