# Enterprise Readiness

This document turns epic #42 into operating decisions. It is deliberately
plain-spoken: some controls are shipped, some are pilot-grade, and some need
IT-owned infrastructure before broad rollout.

## Security Review Packet

The current engineering evidence package is in [`docs/security`](./security/README.md):

- [threat model](./security/THREAT_MODEL.md);
- [incident response runbook](./security/INCIDENT_RESPONSE.md);
- [data flow and classification sheet](./security/DATA_FLOW_AND_CLASSIFICATION.md).

That packet is the source of truth for the deployed security posture and
explicitly separates live controls from enterprise targets. It is engineering
evidence, not a compliance certification or legal DPA.

## Current Status

| Area | Status | Notes |
|---|---|---|
| Dependency audit | Enforced | `pnpm audit --prod --audit-level high` is the required `dependency CVE audit` status check on `main` (#459), so a high/critical production finding blocks merge rather than waiting for release triage. |
| Health checks | Pilot shipped | `/api/health` checks DB connectivity/latency and runtime configuration. |
| Rate limits and quotas | Pilot shipped | `/api/chat`, skill runs, authentication, and event triggers use shared Postgres fixed-window request limits plus body/message caps. Per-team/token/cost quotas are not live. There is no edge-layer (WAF) limit — #691. |
| Logging/redaction/retention | Pilot shipped | Shared tool payload redaction is applied before chat/tool/run/audit persistence; audit retention has a configurable cleanup script and admin visibility. Authentication events are not logged at all — #694. |
| Response security headers | **Not shipped** | The app sends no CSP, HSTS, `nosniff`, `Referrer-Policy`, or `frame-ancestors`. The only CSP covers deployed user-generated apps. #693. |
| KMS/Secrets/IaC | Partial | ECS/Fargate, ALB, task IAM, log groups, alarms, and secret injection are CDK-managed. Secrets Manager uses its AWS-managed key without automatic rotation; RDS storage encryption (#689) and private networking (#492) are not live, and the RDS security group has console-only ingress not present in IaC (#690). |
| Environments | **Single** | Production is the only deployed environment. Merging to `main` deploys, and migrations run against the production database before the new code is live. #697. |
| Load-test model | Model defined, **never executed** | The scenarios and thresholds below are planning assumptions. No harness exists and no run has happened, so no threshold in this document has been measured. #696. |

## Dependency Audit

Run from repo root:

```bash
pnpm audit:prod
```

Since #459 this is not only a release-time step: `.github/workflows/ci.yml`
runs `pnpm audit --prod --audit-level high` as the `dependency CVE audit` job,
and that context is one of the eight required status checks on `main`. A
high or critical finding in the production dependency graph blocks merge.
Moderate and low findings report without blocking.

Result as of 2026-07-25: **0 high, 0 critical**, 4 moderate and 2 low — the
gate is green and the standing findings are all below the blocking threshold.

Mitigations currently carried in `package.json` `pnpm.overrides`:

| Finding | Source | Decision |
|---|---|---|
| Next.js advisories | `next` | Fixed by upgrading `next` to `^15.5.21`. |
| AWS XML parser advisory | `@aws-sdk/client-bedrock-runtime` path | Reduced by upgrading Bedrock SDK to `^3.1048.0`. |
| `sqlite3` / `tar` chain | `drizzle-orm` optional native dependency path | **Resolved, not accepted.** The chain is pruned outright with the `"sqlite3": "-"` override (#459); the earlier "accepted temporarily" triage no longer applies. |
| PostCSS advisory | `next -> postcss` | Mitigated with a pnpm override to `postcss@8.5.18`. |
| `prismjs` advisory | `react-syntax-highlighter -> refractor -> prismjs` | Mitigated with a pnpm override to `prismjs@1.30.0`; assistant markdown rendering still avoids raw HTML. |
| `brace-expansion` ReDoS | transitive | Overrides on the `@1` and `@5` ranges. |
| Archiver/unzipper/glob chain | `archiver`, `exceljs` | Pinned through overrides. |

Acceptance is not "ignore forever." The review cadence is:
- the CI gate blocks high/critical on every PR — no human step required;
- review the moderate/low tail before production release candidates;
- upgrade direct dependencies first;
- document any remaining transitive finding with owner, mitigation, and next
  review date.

## Health Checks

`GET /api/health` returns:

```json
{
  "status": "ok",
  "service": "ai-workspace-web",
  "timestamp": "2026-05-16T00:00:00.000Z",
  "checks": {
    "db": { "ok": true, "latencyMs": 12 },
    "runtime": { "ok": true, "name": "bedrock", "configured": true }
  }
}
```

Status meanings:
- `ok`: DB and runtime configuration are healthy.
- `degraded`: DB is healthy, but runtime configuration is incomplete.
- `unhealthy`: DB connectivity failed. The route returns HTTP 503.

No secret values are returned. Runtime checks intentionally verify
configuration presence only; they do not make a live model call.

## Rate Limits, Quotas, And Cost Guardrails

Shipped pilot controls:
- `CHAT_MAX_REQUEST_BYTES`: maximum request body size before parsing (16 MiB by
  default, allowing one 10 MiB document plus base64 and JSON overhead). Native
  image attachments are capped at Bedrock's 3.75 MB per-image limit.
- `CHAT_MAX_MESSAGE_CHARS`: maximum user message length.
- `CHAT_RATE_LIMIT_WINDOW_MS`: fixed-window duration.
- `CHAT_RATE_LIMIT_REQUESTS`: per-user request count in the window.

The same limiter protects `/api/chat` and the manual Developer Briefing route.
Developer Briefing gets one third of the chat request allowance because it can
perform tool work.

The limiter is shared through Postgres, so all current ECS tasks see the same
logical buckets. Enterprise quota work should add:
- per-user daily token budgets;
- per-team/provider quotas;
- model-specific output-token caps;
- configurable tool/action budgets beyond the runtime's fixed eight-iteration
  cap;
- admin-visible quota/audit events;
- CloudWatch alarms for cost and error-rate spikes.

## Logging, Redaction, And Retention

Default rule: logs should answer "what happened?" without storing the raw work
data unless the user-facing product record already stores it.

Redaction requirements:
- Never log OAuth tokens, refresh tokens, API keys, cookies, auth headers, or
  `OAUTH_ENCRYPTION_KEY`.
- Log provider names and tool names; redact or truncate tool inputs/results by
  default.
- Store full tool inputs/results only in product tables that have retention
  policy and access control, such as `audit_log` and `chat_messages`.
- Error logs may include error class/name and short message. Stack traces are
  allowed in pilot logs but should be disabled or sampled for enterprise.

Current behavior is not an approved retention policy:

| Data | Pilot behavior | Policy status |
|---|---|---|
| Chat messages and artifacts | Persist until an existing user/admin lifecycle action | Window and hard-delete path pending #460 |
| Audit log | Persists; destructive cleanup requires an explicit `AUDIT_LOG_RETENTION_DAYS` | Window, legal hold, and DB enforcement pending #460/#457 |
| Runs, events, and traces | Persist until manual cleanup | Output/metadata windows pending #460/#381 |
| Runtime debug logs | CDK log groups retain 30 days | Confirm with security/privacy before enterprise rollout |
| OAuth tokens | Indefinite — there is no disconnect route (#692) | Disconnect route is #692; deprovisioning and provider rotation policy pending #460 |
| Authentication events | Not recorded anywhere | No sign-in, denial, sign-out, or account-linking event reaches `audit_log` (#694) |
| Future S3/Athena Agent Wire | Not live | Classification and lifecycle policy required before launch |

Current code applies a shared tool payload redaction helper before persisting
tool inputs/results to chat messages, recipe runs, and `audit_log`. Audit
retention can be dry-run with `pnpm audit:retention` and executed with
`AUDIT_LOG_RETENTION_DRY_RUN=0 AUDIT_LOG_RETENTION_DAYS=<approved-days> pnpm audit:retention`;
the script refuses destructive cleanup without an explicit retention window.
Production should run that script on an approved schedule. Follow-up code work:
apply the same policy to `process.stderr` runtime logs before onboarding more
tool providers.

## Secrets, KMS, And IaC

Current pilot state:
- ECS/Fargate task definitions read app/runtime secrets from AWS Secrets
  Manager.
- OAuth tokens are encrypted in Postgres with AES-256-GCM using
  `OAUTH_ENCRYPTION_KEY`.
- CDK owns ECS services, ALB, task IAM, log groups, alarms, and secret
  references. The pre-existing RDS instance, complete CodeBuild project, and
  network are not fully owned by this stack. That divergence has already
  produced one live security finding invisible to `cdk diff`: a console-only
  `0.0.0.0/0` ingress rule on the database security group (#690).
- Secrets Manager uses its AWS-managed key and automatic rotation is not
  enabled.
- The production database connection requires TLS, but the pilot RDS storage
  volume is not encrypted (`StorageEncrypted: false`, verified 2026-07-25) and
  remains publicly addressable. Enabling encryption requires a
  snapshot-copy-restore cutover, not a setting change — #689.
- ECR repositories are `MUTABLE` and both buildspecs push a floating `latest`
  alongside the commit-SHA tag. Traceability rests on the recorded digest in
  the deployment receipt, not on registry-enforced tag immutability — #449.

Enterprise target:
- KMS customer-managed keys protect Secrets Manager values and storage that
  contains user content.
- IaC owns RDS, backups, deletion protection, private networking, and the
  complete deploy pipeline.
- CI/CD continues to assume scoped deploy roles rather than broad long-lived
  credentials.

Secrets inventory:

| Secret | Current | Enterprise target |
|---|---|---|
| `NEXTAUTH_SECRET` | Secrets Manager task injection | Customer-managed KMS key; tested rotation invalidates sessions |
| `DATABASE_URL` | Secrets Manager task injection / CodeBuild migration access | Rotated database credential, private encrypted RDS, scoped migration role |
| `OAUTH_ENCRYPTION_KEY` | Secrets Manager task injection | Customer-managed KMS key, key separation, and re-encryption/rotation plan |
| `GITHUB_AUTH_CLIENT_SECRET` | Secrets Manager task injection | Customer-managed KMS key and provider rotation runbook |
| `GITHUB_CLIENT_SECRET` | Secrets Manager task injection | Customer-managed KMS key and provider rotation runbook |
| `INVITE_EMAIL_PROVIDER`, `INVITE_EMAIL_FROM`, `INVITE_EMAIL_AWS_REGION` | CDK task environment for SES delivery | Reviewed environment configuration; these fields contain no credential |
| AWS deploy credentials | CodeBuild role | Least-privilege deploy role in IaC |

## Invitation Email Rollout

Admin-created invitations attempt transactional email delivery from the admin
panel. Production should use AWS SES so the path stays inside the AWS control
plane:

- Verify the sending domain or address in SES, with DKIM, SPF, and DMARC in
  place before inviting alpha testers outside the sandbox recipient list.
- Configure `INVITE_EMAIL_PROVIDER=ses`, `INVITE_EMAIL_FROM`, and
  `INVITE_EMAIL_AWS_REGION` through Secrets Manager or approved ECS task
  environment configuration.
- Grant the web task role least-privilege SES send permissions for the verified
  identity, for example `ses:SendEmail` on the SES identity ARN.
- Keep SES sandbox limits in mind; request production sending access before
  broad alpha invites.
- Resends deliberately reuse the same still-valid invite token. The token stops
  working once accepted, expired, or revoked.
- If SES is misconfigured or rejects a send, the invite remains visible in the
  admin panel as `failed` so an admin can retry or revoke it without copying raw
  links around.

## Load-Test Model

**Nothing below has been measured.** These are planning assumptions. There is
no k6/Artillery harness, no perf job in CI, and no recorded run — and no
non-production environment to run one against (#697). Treat every number here
as a target to validate, never as evidence. Tracked in #696.

| Stage | Users | Concurrent chat turns | Scheduled runs/hour | Target |
|---|---:|---:|---:|---|
| Pilot | 1k | 25-50 | 100 | Validate UX, DB latency, runtime stability |
| Department rollout | 10k | 250-500 | 1k | Validate shared rate limiter, DB pooling, provider quotas |
| Enterprise | 100k | 2.5k-5k | 10k+ | Validate ECS autoscaling, RDS Proxy/Aurora posture, cost controls |

Synthetic scenarios:
- plain chat with no tools;
- GitHub MCP read-only tool turn;
- Developer Briefing workflow run;
- failed/denied tool attestation path;
- long SSE turn with client disconnect;
- burst of oversized/rate-limited requests.

Initial pass/fail thresholds:
- p95 `/api/health` under 250ms when DB is healthy;
- p95 non-tool chat request accepted under 500ms before first model byte;
- no DB connection exhaustion during burst tests;
- rate-limited requests return 429 with `Retry-After`;
- failed provider/tool calls produce audit rows without leaking secrets;
- cost alarms fire before daily budget breach.

Recommended harness:
- k6 or Artillery for HTTP/SSE load;
- seeded synthetic users and threads;
- stub runtime mode for high-volume app tests;
- small live-runtime tests for provider/model integration only.

Known capacity constraints the model has not yet been tested against: the web
service autoscales between two and four tasks, platform-wide background-run
concurrency is 1 (#448), the rate limiter costs a Postgres round trip per
request, and RDS is a single-AZ instance with no proxy or pooler.
