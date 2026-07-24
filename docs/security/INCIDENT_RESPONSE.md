# Incident Response Runbook

This runbook covers the Comparative pilot in `us-east-1`. It is designed for a
small team: one person may hold several roles, but the incident commander and
evidence record must still be explicit.

## Scope and contacts

- **Alert path:** SNS topic `ai-workspace-ops-alerts`; the current pilot email
  subscription is confirmed.
- **Primary surfaces:** `https://comparative.builtwithrobot.link`, ECS cluster
  `ai-workspace-prod`, RDS PostgreSQL, Bedrock/AgentCore, connected providers,
  and CloudWatch.
- **Evidence systems:** Admin Runs, Admin Audit, `runs`, `run_events`,
  `audit_log`, CloudWatch logs, GitHub PR/deploy history, and CodeBuild
  deployment receipts.
- **Do not place in an incident ticket/chat:** tokens, cookies, authorization
  headers, database URLs, raw Secrets Manager values, or unnecessary user
  content.

Before enterprise rollout, assign an on-call rotation, backup alert recipient,
privacy/legal contact, AWS support plan, customer communication owner, and
approved incident-record location.

## Severity

| Severity | Definition | Examples | Initial target |
|---|---|---|---|
| SEV-1 | Confirmed or likely Restricted-secret compromise, cross-user disclosure, destructive unauthorized write, material data loss, or widespread outage | OAuth/database/session secret exposed; another user sees private content; RDS unavailable/deleted | Acknowledge immediately; contain before routine debugging |
| SEV-2 | Suspected security event, bounded provider misuse, repeated worker/model failure, or major feature outage | Tool writes outside intent; run-failure burst; one execution lane down | Acknowledge within 30 minutes during staffed pilot hours |
| SEV-3 | Degraded behavior with a safe workaround and no evidence of disclosure | One provider unavailable; memory capture stopped; elevated latency | Triage during the same working day |
| SEV-4 | Observation, false positive, or low-risk defect | Single user error with complete audit evidence | Normal backlog |

When impact is unknown, start one level higher and downgrade with evidence.
Notification deadlines are owned by privacy/legal policy, not this engineering
document.

## First 15 minutes

1. **Declare:** create an incident ID, severity, UTC start time, incident
   commander, technical lead, evidence recorder, and communications owner.
2. **Preserve:** record the triggering alarm, affected user/run/thread/provider
   IDs, current deploy SHA/task definitions, and relevant timestamps. Do not
   delete rows, logs, tokens, or compromised artifacts before capture.
3. **Scope:** decide whether impact is credential, confidentiality, integrity,
   availability, model/tool safety, or a combination. Identify the smallest
   affected boundary.
4. **Contain:** stop further exposure or side effects before seeking a perfect
   root cause. Prefer revoking one token/tool/user/run over taking down the
   whole workspace when that is safe.
5. **Communicate:** state what is known, unknown, contained, and next. Do not
   claim "no data accessed" without audit/provider evidence.

## Operational triage

Set the region once:

```bash
export AWS_DEFAULT_REGION=us-east-1
```

Check alarm and service state:

```bash
aws cloudwatch describe-alarms \
  --state-value ALARM \
  --query 'MetricAlarms[].{name:AlarmName,reason:StateReason,updated:StateUpdatedTimestamp}'

aws ecs describe-services \
  --cluster ai-workspace-prod \
  --services ai-workspace-web ai-workspace-chat-worker ai-workspace-memory-worker \
  --query 'services[].{service:serviceName,desired:desiredCount,running:runningCount,pending:pendingCount,events:events[0:5]}'
```

Read only the required time window:

```bash
aws logs tail /ecs/ai-workspace/web --since 30m
aws logs tail /ecs/ai-workspace/chat-worker --since 30m
aws logs tail /ecs/ai-workspace/memory-worker --since 30m
```

Use the Admin Runs/Audit UI before direct database access. Correlate on
`run_id`, `chat_thread_id`, `chat_message_id`, `tool_call_id`, actor user ID,
provider, action type, and UTC timestamps. Export only the minimum redacted
evidence needed for the incident record.

The current routed alarms cover:

- chat-worker and memory-worker live task count below one;
- target and load-balancer 5xx bursts;
- unhealthy web targets;
- chat-worker terminal run-failure bursts.

The CDK alarm `ai-workspace-memory-capture-failures` currently has no SNS
action. Check it manually during memory incidents and wire it before broader
rollout.

## Containment by incident class

### Restricted credential or session exposure

1. Revoke the credential at its authority first: connected provider, database,
   AWS IAM, or application session.
2. For one user's provider token, disconnect/revoke that provider and cancel
   active affected runs. Do not rotate the shared OAuth encryption key as a
   first response; changing it without re-encryption makes every stored token
   unreadable.
3. For a provider OAuth client-secret exposure, rotate the client secret,
   update the existing Secrets Manager field, redeploy tasks, and determine
   whether provider-issued user tokens must also be revoked.
4. For a `NEXTAUTH_SECRET` exposure, rotate it and redeploy; expect all JWT
   sessions and outstanding magic-link hashes to become invalid.
5. For database credential exposure, restrict network access, rotate the
   credential, update Secrets Manager, redeploy, and inspect database/audit
   activity from before the earliest possible exposure.
6. Search GitHub, logs, feedback, traces, and artifacts for copies. Revoke
   first; redact history second.

### Cross-user disclosure or authorization bypass

1. Disable the narrow route/feature or remove public access if exploitation is
   ongoing. If scope is unclear, stop the web service from serving private
   data until the boundary is understood.
2. Preserve the affected response, route, caller identity, target owner,
   `admin_data_access` receipts, and surrounding audit/run events.
3. Test the suspected IDOR with a synthetic user; never reproduce against more
   real user data than required.
4. Fix owner/write scoping and add a denied-path regression test.
5. Identify every potentially affected owner and time window from audit,
   provider, access, and deployment evidence. Escalate notification decisions
   to privacy/legal.

### Prompt injection or unauthorized tool side effect

1. Cancel the run and prevent another attempt.
2. Revoke or disconnect the affected provider/token, disable the tool/provider
   in the governed catalog where available, or remove the user's attestation.
3. Preserve the untrusted source, framed prompt evidence, tool call/result,
   write-authorization receipt, provider-side object ID, and audit row.
4. Reverse the provider-side change only after preserving evidence and
   confirming reversal is safe.
5. Determine whether the failure was framing, discovery/mounting,
   authorization policy, provider validation, or model behavior. A prompt-only
   fix is not sufficient for an authorization defect.

### Malicious upload, artifact, or deployed app

1. Remove sharing/deployment access to the affected artifact/app and stop
   further processing.
2. Preserve the original bytes or content hash in restricted evidence storage;
   do not open an untrusted file on an operator workstation.
3. Inspect validation, extraction, secret-scan, prompt framing, CSP, and
   owner/share decisions.
4. Patch with a representative fixture and negative test for the affected file
   type or rendering path.

### Database integrity, loss, or availability

1. Stop writes if continuing could worsen corruption or destroy evidence.
2. Record instance state, events, alarms, backup/snapshot inventory, task
   definitions, and deploy SHA.
3. Restrict the public/database perimeter and rotate credentials if compromise
   is suspected.
4. Restore into an isolated target first; validate schema, owner scoping,
   audit/run continuity, and application smoke before cutover.
5. The pilot is single-AZ with one day of automated backups and no deletion
   protection. Treat untested recovery as SEV-1 uncertainty and open an AWS
   support case when needed.

### Runtime or deployment outage

1. Determine whether the web, chat worker, memory worker, RDS, Bedrock,
   AgentCore, or one provider is the failing boundary.
2. If the current immutable image is the regression and the schema remains
   backward compatible, run:

```bash
AWS_DEFAULT_REGION=us-east-1 ./infra/scripts/rollback-ecs.sh <known-good-commit-sha>
```

3. Do not roll application code backward across an incompatible migration.
   Follow [Production deployment](../PRODUCTION_DEPLOYMENT.md).
4. Confirm ECS stability, `/api/health`, authenticated product smoke, queued
   run recovery, and memory backlog before closing.

## Recovery and validation

Recovery is complete only when:

- compromised credentials are revoked/rotated and old credentials fail;
- the boundary defect has a regression test and reviewed PR;
- CI, integration tests, build, Product Smoke, and independent review pass for
  the exact merged head;
- production deploy receipt and task definitions match that commit;
- `/api/health`, one authenticated chat, affected provider behavior, run
  persistence, audit receipts, and worker backlogs are verified;
- temporary containment is either removed deliberately or converted into a
  tracked permanent control;
- heightened monitoring runs for an incident-appropriate period.

## Evidence checklist

- Incident ID, UTC timeline, severity changes, and named roles.
- Triggering alarm/report and earliest-known event.
- Affected user/resource/provider/run identifiers, without unnecessary
  content.
- Deploy commit, task-definition ARNs, model/runtime, and provider.
- Redacted audit rows, run events, relevant CloudWatch extracts, and provider
  audit evidence.
- Containment commands/actions, credential rotation/revocation evidence, and
  who approved them.
- Root cause, contributing controls/gaps, tests, PR, merge verification,
  deployment receipt, and recovery checks.
- User/customer/privacy/legal communications and decisions.

## Post-incident

Within five working days for SEV-1/2:

1. Write a blameless timeline and root-cause analysis.
2. Separate the triggering defect from detection, containment, recovery, and
   documentation gaps.
3. Create owned, ranked GitHub issues with severity and acceptance criteria.
4. Update this runbook, the threat model, data-flow inventory, alerting, and
   regression suite.
5. Record whether residual risk was fixed, transferred, avoided, or explicitly
   accepted by the authorized owner.
