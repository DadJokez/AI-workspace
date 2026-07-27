# Runbook: AgentCore runtime rollback

**Status: written, never executed.**

**Purpose.** Roll the Bedrock AgentCore runtime back to a previously deployed
image when a bad agent build reaches production. ECS has a one-command
rollback (`infra/scripts/rollback-ecs.sh`); AgentCore does not. This is the
manual equivalent, and it has a trap in it that will bite anyone who does not
read step 3 first.

## What you are rolling back

- **Stack:** `AiWorkspaceAgentCoreSpikeStack` (CloudFormation, `us-east-1`).
- **Runtime:** `AWS::BedrockAgentCore::Runtime`, `AgentRuntimeName`
  `ai_workspace_agent_spike`, declared in
  `infra/cdk/lib/ai-workspace-agentcore-spike-stack.ts`.
- **Image:** `ai-workspace-agentcore-agent` in ECR, referenced from the
  template as `<repo>:<AgentImageTag>` — a **tag, not a digest**, in a
  `MUTABLE` repository (#449).
- **The only supported write path is CloudFormation.** CodeBuild never mutates
  the runtime directly, and neither should you. Calling
  `bedrock-agentcore update-agent-runtime` by hand puts the live runtime out of
  sync with the stack, and the next deploy will silently revert your fix.

## Decide first: is AgentCore actually the failure?

AgentCore serves **worker turns**; direct Bedrock serves fast interactive
turns. If interactive chat is healthy and background/scheduled runs are not,
AgentCore is a good suspect. If both are broken, roll ECS first — it is faster
and more likely.

The deployment receipt in the CodeBuild log is the authority for what is
running. It carries the commit SHA, image digest and tag, stack status,
deployment sequence, and source-template SHA-256.

## Procedure

### 1. Capture the current state

```bash
export AWS_DEFAULT_REGION=us-east-1
aws cloudformation describe-stacks --stack-name AiWorkspaceAgentCoreSpikeStack \
  --query 'Stacks[0].{status:StackStatus,params:Parameters}'
```

Write down the current `AgentImageTag`, `DeploymentSequence`, and
`SourceTemplateSha256`. **You need the current `DeploymentSequence` for step 3.**

### 2. Pick and verify the target image

```bash
GOOD=<known-good-commit-sha>
aws ecr describe-images --repository-name ai-workspace-agentcore-agent \
  --image-ids imageTag="$GOOD" \
  --query 'imageDetails[0].{digest:imageDigest,pushed:imagePushedAt}'
```

If that returns nothing, the image is gone and this runbook cannot help — you
are rebuilding, not rolling back. Record the digest; it goes in the incident
record.

### 3. Check out the matching commit — and mind the sequence guard

`infra/scripts/update-agentcore-stack.sh` synthesizes the template **from the
working tree**, so check out the commit whose infrastructure you want live:

```bash
git checkout "$GOOD"
```

**The trap.** The script refuses to deploy a build it considers superseded:

```
if (( deployed_sequence > AGENTCORE_DEPLOY_SEQUENCE )); then
  echo "AgentCore deployment $AGENTCORE_DEPLOY_SEQUENCE was superseded by sequence $deployed_sequence." >&2
  exit 1
fi
```

That guard exists to stop an out-of-order production handoff, and during a
rollback it fires on you: the good build's original `CODEBUILD_BUILD_NUMBER` is
by definition *lower* than the bad one now deployed. A rollback is a new,
later deployment of older content, so it needs a **higher** sequence than what
is deployed — not the old build's number.

```bash
CURRENT_SEQ=<DeploymentSequence from step 1>
AGENTCORE_STACK_NAME=AiWorkspaceAgentCoreSpikeStack \
AGENTCORE_IMAGE_TAG="$GOOD" \
AGENTCORE_DEPLOY_SEQUENCE=$(( CURRENT_SEQ + 1 )) \
  ./infra/scripts/update-agentcore-stack.sh
```

The script verifies the tag resolves to a `sha256:` digest, checks the
synthesized template is under CloudFormation's 51,200-byte inline limit,
submits the update, and waits for `stack-update-complete`.

Note the side effect: the next normal CodeBuild deploy uses
`CODEBUILD_BUILD_NUMBER`, which may now be **below** the sequence you just
wrote. If so, that deploy fails the same guard. Record what you set and expect
to either bump the CodeBuild build number or repeat this manual path for the
fix-forward deploy. Do not treat that failure as a new incident.

### 4. Verify

```bash
aws cloudformation describe-stacks --stack-name AiWorkspaceAgentCoreSpikeStack \
  --query 'Stacks[0].{status:StackStatus,params:Parameters}'
```

`StackStatus` must be `UPDATE_COMPLETE` and `AgentImageTag` must be `$GOOD`.
Then confirm behavior, not just state: run a background/scheduled turn end to
end and check `/aws/bedrock-agentcore/*` CloudWatch logs for the restored
build. A green stack with a broken agent is not a completed rollback.

### 5. Close the loop

- Return the working tree to `main` (`git checkout main`) so nobody deploys
  from a detached rollback checkout by accident.
- Record in the incident: bad tag, good tag, both digests, the sequence you
  used, and the ECS state at the time.
- **Fix forward.** A manual rollback leaves the stack ahead of `main` in
  sequence and behind it in content. That is a temporary state; it needs a real
  PR through the normal gate.

## Constraints and gaps

- **Not automated.** There is no `rollback-agentcore.sh`. Every step above is
  manual, and the sequence arithmetic in step 3 is the part most likely to be
  got wrong under pressure. A script that reads the deployed sequence and
  increments it would remove the trap entirely — worth doing before this is
  ever needed.
- **Never rehearsed.** No drill has been run, and there is no non-production
  AgentCore stack to rehearse against (#697).
- **Image retention is unbounded and unguaranteed.** The ECR repository has no
  lifecycle policy today, so old images happen to still be there. Nothing
  enforces that, and mutable tags mean a tag could have been repointed (#449).
- **Rolling the agent alone can desynchronize the deployment.** ECS and
  AgentCore are normally deployed from the same commit. If you roll AgentCore
  without ECS, the two are on different builds until you fix forward — check
  whether the interface between them changed in the bad commit before
  assuming that is safe.

## Related

- `docs/PRODUCTION_DEPLOYMENT.md` — ordered deployment path and ECS rollback.
- `docs/security/INCIDENT_RESPONSE.md` — "Runtime or deployment outage".
- #449 — mutable tags / digest pinning.
- #467 — pipeline not reconstructable in IaC.
- #697 — no staging environment to rehearse in.
