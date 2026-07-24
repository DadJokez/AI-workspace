# Eval Automation Setup

This document is the operational companion to
[`CORE_EVAL_PROGRAM.md`](./CORE_EVAL_PROGRAM.md). The program defines what
Comparative must prove; this document defines when those proofs run and how
GitHub receives the narrowly scoped AWS identity needed for real-model checks.

## Automated Gates

| Lane | Trigger | Command | Failure behavior |
| --- | --- | --- | --- |
| Required deterministic CI | Every pull request and every `main` push | All 126 eval definitions via `pnpm eval --mock`, plus `pnpm transcripts:replay`, inside `CI` | Fails the existing required `lint + typecheck + build` job |
| Required real core pipeline | Every pull request, every `main` push, every six-hour schedule, and manual dispatch | `pnpm smoke:browser:core` inside `Product Smoke` | On PRs/pushes, fails the existing required `local browser smoke` summary |
| Foundational real-model PR evals | Every ready, same-repository pull request | `BEDROCK_CLIENT=real pnpm eval --core` inside `Product Smoke` | Fans into and fails the existing required `local browser smoke` result; superseded commits are cancelled |
| Comprehensive nightly evals | Every day at 07:00 UTC and manual dispatch on `main` | Independent `BEDROCK_CLIENT=real pnpm eval` and app-backed real-Bedrock CSV lanes | Either lane fails the workflow without suppressing the other, retains available reports/screenshots/traces, and independently opens or refreshes the `Nightly evals failing` issue |
| Advisory Codex browser-user evals | Local Codex scheduled task after canary-profile provisioning, plus manual pre-release runs | `$comparative-browser-evals` through the Codex in-app Browser | Reports exact `PASS`/`FAIL`/`BLOCKED` scorecards in Scheduled; never fans into branch protection |

The real core pipeline canary uses Chromium, a disposable Postgres service, and
a deterministic test model. It sends a canary CSV through the actual `/api/chat`
route, persistence layer, conversation-resource tool, streaming response,
thread reload, and later-turn retrieval. It does not intercept the chat API and
does not need AWS or live provider credentials.

`Product Smoke` uses `pull_request`, not `pull_request_target`. Fork pull
requests and drafts do not receive an AWS identity. A draft receives its run
when it becomes ready for review. The real-model job is always present so the
required fan-in is stable, but only ready same-repository code receives an OIDC
token.

Both real-model lanes fail closed when `AWS_EVAL_ROLE_ARN` is absent. Neither
can silently produce a green no-op run.

## Codex Browser-User Lane

This lane is separate because GitHub's Linux runners can execute headless
Playwright but cannot control the desktop app's in-app Browser or its dedicated
browser profile. Its versioned contract lives in
`.agents/skills/comparative-browser-evals`.

The two initial canaries cover:

1. a synthetic CSV attached through visible UI, exact grounded facts before
   and after reload, and a same-file follow-up; and
2. a uniquely named HTML artifact created and previewed through visible UI,
   reloaded, revised in place, and verified again after reload.

The scheduled prompt must name the expected visible canary-account label and
explicitly authorize upload of only the committed synthetic CSV to the
Comparative target. The browser profile must be signed into that dedicated
account and the site must be allowed before activation. A login redirect,
identity mismatch, missing site permission, unavailable target, or unsupported
browser capability is reported as `BLOCKED` rather than a pass.

The computer and desktop app must be running for local scheduled tasks. The
canary account is intentionally separate from alpha-tester data, and unattended
runs do not delete created chats or artifacts because browser deletion requires
action-time confirmation. Obvious `CBX-…` run ids make canary records
identifiable for later TTL cleanup.

Do not activate the schedule until the exact prompt passes once manually in the
in-app Browser. Keep the lane advisory until 30 consecutive stable runs
establish its infrastructure-failure rate. Any product failure it discovers
must be reduced to the cheapest deterministic regression before the fix
merges.

## Cost And Concurrency Bounds

- PR evals run only the foundational `--core` subset, allow one active run per
  pull request, cancel superseded commits, time out after 25 minutes, and trip
  at an estimated `$1.50` per completed run. A calibrated 59-case run on
  2026-07-23 cost about `$1.03`; the tripwire leaves headroom for output
  variance while forcing review of unplanned suite growth.
- Nightly evals allow only one active workflow run. The independent behavior
  and browser lanes time out after 35 and 20 minutes respectively. The behavior
  report trips above an estimated `$5.00` per completed suite; the additional
  two-turn app-backed canary is intentionally outside that report estimate and
  adds only its actual Bedrock turn usage.
- The workflows request sessions that expire after 30 minutes for PRs, one hour
  for the nightly behavior lane, and 30 minutes for the nightly browser lane.
- Reports are uploaded when the job reaches its upload steps. A hard timeout
  can prevent upload, so failure notification runs in a separate dependent job.

The reported-cost threshold is a regression tripwire after the calls complete.
The core subset, job timeout, short credential lifetime, and concurrency limit
are the controls that bound calls while a run is active.

## AWS Boundary

`AiWorkspaceEvalCiStack` is intentionally separate from the production ECS and
AgentCore stacks. It creates:

1. the account's GitHub Actions OIDC provider; and
2. `ComparativeGitHubEvalsRole`.

The role can only call `bedrock:InvokeModelWithResponseStream` for:

- `us.anthropic.claude-haiku-4-5-20251001-v1:0`; and
- `us.anthropic.claude-sonnet-4-6`.

The policy names the two inference profiles and their backing foundation-model
ARNs in `us-east-1`, `us-east-2`, and `us-west-2`. It has no access to
Comparative databases, application secrets, OAuth credentials, ECS,
CloudFormation, GitHub, or provider APIs. Adding another model to the eval
harness therefore requires an explicit IAM policy review.

Trust is restricted to repository `DadJokez/AI-workspace`, immutable repository
ID `1224105845`, owner ID `23159363`, audience `sts.amazonaws.com`, and these
exact workflow/ref pairs:

- `Nightly Evals` on `refs/heads/main`;
- `Product Smoke` on `refs/pull/*/merge`.

Both the repository's current classic OIDC subjects and its immutable
ID-qualified subjects are accepted. The PR workflow independently verifies
that the head repository equals the base repository before requesting a token.

## Deployment And Verification

The isolated stack and repository variable were activated on 2026-07-23. The
commands below are the reproducible deployment/verification procedure; CI
synthesis itself does not deploy anything.

First, inspect and deploy only the isolated eval stack:

```bash
CDK_DEFAULT_ACCOUNT=351478076796 \
CDK_DEFAULT_REGION=us-east-1 \
pnpm --filter @ai-workspace/infra exec cdk diff AiWorkspaceEvalCiStack

CDK_DEFAULT_ACCOUNT=351478076796 \
CDK_DEFAULT_REGION=us-east-1 \
pnpm --filter @ai-workspace/infra exec cdk deploy AiWorkspaceEvalCiStack
```

Then copy the CloudFormation output into the repository-level Actions
variable:

```bash
eval_role_arn="$(
  aws cloudformation describe-stacks \
    --stack-name AiWorkspaceEvalCiStack \
    --region us-east-1 \
    --query "Stacks[0].Outputs[?OutputKey=='AwsEvalRoleArn'].OutputValue | [0]" \
    --output text
)"

test -n "$eval_role_arn"
test "$eval_role_arn" != "None"

gh variable set AWS_EVAL_ROLE_ARN \
  --repo DadJokez/AI-workspace \
  --body "$eval_role_arn"
```

`AWS_EVAL_ROLE_ARN` is a repository variable, not a secret: an IAM role ARN is
an identifier, while the short-lived credentials come from the signed OIDC
exchange.

Finally, verify the value and exercise the nightly path on `main`:

```bash
gh variable get AWS_EVAL_ROLE_ARN --repo DadJokez/AI-workspace
gh workflow run nightly-evals.yml --repo DadJokez/AI-workspace --ref main
gh run list --repo DadJokez/AI-workspace --workflow nightly-evals.yml --limit 1
```

Manual nightly dispatches from non-`main` refs fail the IAM trust policy by
design.

## Operational Response

When a run fails:

1. Open its uploaded `eval-report` artifact.
2. Separate deterministic failures, judge failures, model errors, and budget
   violations.
3. Use the recorded thread/run IDs with `/admin/runs/{runId}` when the case is
   app-backed.
4. Turn any newly discovered alpha failure into a permanent deterministic,
   browser, or real-model regression before fixing it.
5. Do not widen the IAM role to fix model access until the new model and cost
   are intentionally part of the eval program.

The nightly issue automation also reports missing OIDC configuration, so a
deleted variable or stack cannot masquerade as healthy product quality.
