# Runbook: break-glass access

**Status: written, never executed.** The role exists in an environment once its `00-foundation` has
been applied with `break_glass_principal_arns` filled in; until the first use below, nobody has proved
that the notice reaches a person.

**Purpose.** Change an environment by hand when the pipeline cannot do it in time, and get every such
change back into Git. Applies to the environments the Terraform pipeline manages (`personal-stage`
today, production after the cutover, WP-20). Production on CDK has no break-glass role: see
[Production deployment](../PRODUCTION_DEPLOYMENT.md), "CDK (until cutover)".

## The rule

**Every change made with the break-glass role is reconciled into Git within one working day.**
Reconciled means that `main` and AWS agree again: the change is merged through a pull request (so the
next plan shows nothing to do), or it is undone in AWS. The drift workflow enforces it (see "After").

## What the role is

| | |
|---|---|
| Name | `<name_prefix>-break-glass`, for example `cmp-personal-stage-break-glass` |
| Who | The IAM principals listed in `break_glass_principal_arns` of `envs/<env>/env.tfvars`. Rob decides who is on the list; a change to it is a reviewed pull request applied by hand to `00-foundation`. |
| How | `sts:AssumeRole` with MFA that is at most an hour old; sessions last at most one hour. A principal that is a role can assume it only from a session that carries MFA, which a chained role session does not, so in practice the list holds IAM users with MFA devices. GitHub workflows cannot assume it. |
| May | Read everything in the account (`ReadOnlyAccess`). Change what the pipeline's apply role may change, with the same policy documents: the resources of stacks `10` to `60` and their Terraform state. |
| May not | Read a secret value. Change IAM outside `/comparative/<env>/` or a role without the workload boundary. Change `00-foundation` (keys, CI roles, the boundary, this role). Change the ops alert topic or the rule that reports this role's use. |
| Noticed | Every `AssumeRole` of the role (and a console switch to it) notifies the ops alert topic `<name_prefix>-ops-alerts`, through the EventBridge rule `<name_prefix>-break-glass-assumed`. |

Anything wider, such as a change to `00-foundation`, is the account administrator's, with their own
credentials, as it is without an incident.

## When it may be used

All of these hold:

1. Something is broken or exposed now (an outage, a security incident, data at risk), and waiting
   makes it worse.
2. The normal path cannot fix it in time: a pull request, its plan, the merge and the apply on merge.
   For example GitHub or Actions is down, the apply role or the pipeline itself is broken, or the fix
   cannot wait for review and apply.
3. You have said in the incident (see [Incident response](../security/INCIDENT_RESPONSE.md)) that you
   are using it, and why.

It is not for: a routine change, skipping review, reading data out of the environment, a change the
pipeline can make in time, or anything in `00-foundation`.

## How

Prefer a change that is already in Git: make it on a branch and run `tf.sh` from that branch with the
role's credentials. The change is then reconciled as soon as its pull request merges. Use the console or
the AWS CLI only when Terraform cannot be run.

1. **Assume the role** through the STS endpoint of the environment's region, so that the notice rule
   (which sees that region only) receives the event:

   ```bash
   export AWS_REGION=us-east-1 AWS_STS_REGIONAL_ENDPOINTS=regional
   aws sts assume-role \
     --role-arn arn:aws:iam::<account>:role/cmp-<env>-break-glass \
     --role-session-name "<your name>" \
     --serial-number <your MFA device ARN> --token-code <code> \
     --duration-seconds 3600
   ```

   Export the three values it returns (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
   `AWS_SESSION_TOKEN`) in that shell only. In the console, sign in with MFA and use **Switch role**
   with the same role name; the notice for a console switch has not been checked against a real event,
   so say in the incident that you switched.

2. **Check that the notice arrived** at the ops alert addresses. If it did not, say so in the incident:
   the use is then visible only in CloudTrail.

3. **Make the change, and write down each one** in the incident as you go: what, where (stack,
   resource) and why. With Terraform:

   ```bash
   infra/terraform/tf.sh <env> <stack> plan     # read the plan
   infra/terraform/tf.sh <env> <stack> apply
   ```

   `apply` takes the state lock, as the pipeline does: do not run it while an apply on merge is
   running for the environment.

4. **Drop the credentials** when done (close the shell, or sign out of the role in the console). The
   session ends by itself after an hour.

## After: reconcile within one working day

Open a pull request that puts the change into Git, or undo the change in AWS. A pull request that
matches what you did plans with no changes for the stacks you touched; its plan comment shows it.

The drift workflow (`.github/workflows/terraform-drift.yml`) runs every night. While AWS differs from
`main`, it keeps one issue per environment open, **Terraform drift: `<env>`**, labelled `ops`, with the
stacks that differ and the deadline: 00:00 UTC of the working day after the first report (a report on a
Saturday or Sunday counts from Monday; public holidays are not known to it). A run that finds the issue
still open past the deadline fails. The issue closes by itself on the first run that finds no drift;
run **Terraform Drift** by hand on `main` to check sooner. Close the incident only after that.

What the drift workflow sees: every change to what a stack manages, and a security group rule added
beside the managed ones. What it does not see: a resource that no stack declares (a security group or a
service created by hand) and attributes a stack ignores. Delete such resources, or bring them into a
stack with an `import` block in the reconciling pull request, and say which in the incident.

## Prove the notice (once per environment, after the first apply)

The notice depends on four things that no plan can prove: CloudTrail delivering the event to
EventBridge, the rule's pattern, the topic policy of `60-observability`, and the logs key policy of
`00-foundation`. After both stacks are applied and the subscriptions are confirmed, a named principal
assumes the role once (step 1 above) and does nothing else. Within a few minutes the ops alert
addresses receive a message that starts with `Break-glass:`.

If none arrives:

```bash
aws events describe-rule --name cmp-<env>-break-glass-assumed            # State: ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS
aws cloudwatch get-metric-statistics --namespace AWS/Events \
  --metric-name MatchedEvents --dimensions Name=RuleName,Value=cmp-<env>-break-glass-assumed \
  --start-time <an hour ago> --end-time <now> --period 300 --statistics Sum
aws cloudwatch get-metric-statistics --namespace AWS/Events \
  --metric-name FailedInvocations --dimensions Name=RuleName,Value=cmp-<env>-break-glass-assumed \
  --start-time <an hour ago> --end-time <now> --period 300 --statistics Sum
```

No `MatchedEvents`: the event did not reach the rule (wrong region or endpoint, no CloudTrail delivery,
or a pattern that does not match the recorded event; compare it with the `AssumeRole` event in
CloudTrail). `FailedInvocations`: the topic refused it (the `EventBridgeRules` statement of the topic
policy, or `EventBridgeToOpsTopic` of the logs key). Record the result in this runbook's status line.
