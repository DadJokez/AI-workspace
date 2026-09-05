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
| Dependency audit | Enforced, with a documented fail-open | `scripts/audit-prod-deps.sh` is the required `dependency CVE audit` status check on `main` (#459). A high/critical production finding blocks the merge — detected structurally from `pnpm audit --json`, never by pattern-matching the printed table. If the advisory registry is unreachable the gate **warns and passes** rather than blocking, because absence of information is not evidence of a vulnerability; that fail-open is only safe while Dependabot alerts (enabled 2026-07-25) cover this tree over a separate path. The requirement to restore fail-closed if Dependabot is ever disabled is recorded in the workflow itself (`.github/workflows/ci.yml`, `dependency-audit` job comment) so it cannot be lost; PR #714 is the origin. |
| Health checks | Pilot shipped | `/api/health` checks DB connectivity/latency and runtime configuration. |
| Rate limits and quotas | Pilot shipped | `/api/chat`, skill runs, authentication, and event triggers use shared Postgres fixed-window request limits plus body/message caps. Per-team/token/cost quotas are not live. There is no edge-layer (WAF) limit — #691. |
| Logging/redaction/retention | Pilot shipped | Shared tool payload redaction is applied before chat/tool/run/audit persistence; audit retention has a configurable cleanup script and admin visibility. |
| Browser security headers | Partial | HSTS, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and `X-Frame-Options: DENY` ship on every response from `apps/web/next.config.mjs` (#702). The CSP is **report-only** until a soak confirms no violations; `/apps/<slug>` is the one framing exemption (SAMEORIGIN, matching the deployed-app document's own `frame-ancestors 'self'`). |
| Authentication auditing | Pilot shipped | Sign-in, invite-gate denial, and sign-out write `audit_log` rows with provider, client IP, and user-agent (#702; see `docs/AUDIT_SURFACES.md`). Sessions carry an explicit 24h idle expiry; per-user revocation needs a token-version column and is not live. |
| KMS/Secrets/IaC | Partial | ECS/Fargate, ALB, task IAM, log groups, alarms, and secret injection are CDK-managed. Secrets Manager uses its AWS-managed key without automatic rotation; RDS storage encryption (#689) and full private-network adoption (#492) are not live. A deployment-time reconciler keeps the pre-existing RDS instance non-public and rejects security-group drift (#690). |
| Environments | **Single** | Production is the only deployed environment. Merging to `main` deploys, and migrations run against the production database before the new code is live. #697. |
| Load-test model | **Pilot row measured locally on 2026-09-05** (see results below); production run pending Rob | `scripts/load/pilot-load.mjs` ran the pilot row (50 concurrent `/api/health`, 25 concurrent chat turns across 1k seeded users, a 300-request rate-limit burst) against a production build and Postgres 16 on a laptop with the fake model. The four thresholds the harness can measure all pass with wide margin. A laptop is not the deployed topology (ALB, 2–4 ECS tasks, single-AZ RDS, no pooler), so the production row is still unmeasured. #696. |

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
| OAuth tokens | Active credentials persist until owner/admin disconnect; disconnect scrubs local token material and retains lifecycle metadata | Provider-side revocation is pending #692; deprovisioning and rotation policy pending #460/#836 |
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
  network are not fully owned by this stack. Until #492 adopts RDS, the
  deployment's fail-closed perimeter reconciler keeps it non-public, permits
  only the three reviewed ECS security-group paths, and rejects console drift.
- Secrets Manager uses its AWS-managed key and automatic rotation is not
  enabled.
- The production database connection requires TLS, and the pilot RDS instance
  is non-public. Its storage volume is not encrypted (`StorageEncrypted:
  false`, verified 2026-07-25). Enabling encryption requires a
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

The pilot row was **measured once, locally, on 2026-09-05** with
`scripts/load/pilot-load.mjs` (#696). The department and enterprise rows are
still planning assumptions, and the production pilot row is unmeasured: there
is no non-production environment (#697) and load against production is Rob's
call. Treat the local numbers as a floor on what the application code and
schema can do, not as evidence about the deployed topology.

| Stage | Users | Concurrent chat turns | Scheduled runs/hour | Target | Status |
|---|---:|---:|---:|---|---|
| Pilot | 1k | 25-50 | 100 | Validate UX, DB latency, runtime stability | Measured locally 2026-09-05 (below); production run pending |
| Department rollout | 10k | 250-500 | 1k | Validate shared rate limiter, DB pooling, provider quotas | Assumption |
| Enterprise | 100k | 2.5k-5k | 10k+ | Validate ECS autoscaling, RDS Proxy/Aurora posture, cost controls | Assumption |

### Pilot row, local run (2026-09-05)

Setup: production build (`next build` + `next start`, single process) with
the same server environment as the CI authenticated-smoke lane
(`BEDROCK_CLIENT=fake`, `CHAT_RUN_IN_PROCESS_WORKER=1`), against a dedicated
local PostgreSQL 16.14 database with 1,000 seeded synthetic users. Apple M4,
10 cores, 16 GiB RAM, macOS 26.6, Node 24.14. The fake model echoes the
prompt with a fixed 30 ms per 4-character chunk, so every chat turn's
*full* duration is that artificial stream, not Bedrock; the number that
matters for the app + database path is time to the `meta` event (the turn is
persisted and accepted). The app's Postgres pool is 10 connections per
process (`packages/db/src/client.ts`); `max_connections` was 100.

| Scenario | Load | Result |
|---|---|---|
| `health` — `GET /api/health` | 50 concurrent, closed loop, 60 s | 246,752 requests (4,112 req/s); p50 11.9 ms, **p95 15.2 ms**, p99 19.1 ms, max 101.5 ms; server-reported DB ping p95 11 ms; 0 errors |
| `chat` — plain turns, no tools | 25 concurrent, 60 s, rotating 1k users | 1,275 turns (21.2/s, bounded by the fake stream); time-to-`meta` p50 37.0 ms, **p95 44.4 ms**, p99 98.2 ms; full turn p95 1,199 ms; 0 × 429, 0 × 5xx, 0 failed streams; 1,275/1,275 answered by the fake model; `pg_stat_activity` peak 11 (10-connection pool + autovacuum) |
| `burst` — one user, 300 `POST /api/chat` | 50 concurrent, 1.2 s | 30 × 200 (the window), 30 × 413 (oversized bodies), **240 × 429, all with `Retry-After`**; 429 p95 42.3 ms; 0 × 5xx; `pg_stat_activity` peak 10 of 100 |

Thresholds, as measured on that run:
- p95 `/api/health` under 250ms when DB is healthy — **pass**, 15.2 ms;
- p95 non-tool chat request accepted under 500ms before first model byte —
  **pass**, 44.4 ms to `meta` at 25 concurrent;
- no DB connection exhaustion during burst tests — **pass**, peak 10 of 100
  (the pool cap; excess work queues in-process rather than opening
  connections), no 5xx;
- rate-limited requests return 429 with `Retry-After` — **pass**, 240/240;
- failed provider/tool calls produce audit rows without leaking secrets —
  not exercised by this harness (covered by unit tests, not load);
- cost alarms fire before daily budget breach — not exercised (no spend in
  fake mode).

What the local run cannot say: the ALB, ECS autoscaling between two and four
tasks, the single-AZ RDS instance with no proxy or pooler, and real Bedrock
latency and quotas were not in the path. With 2–4 tasks each holding a
10-connection pool, production peaks at 20–40 app connections — check that
against the RDS instance class's `max_connections` before the department
row. Platform-wide background-run concurrency is still 1 (#448); the inline
chat lane measured here does not use it.

Synthetic scenarios (measured: 1 and 6; the rest remain unbuilt):
- plain chat with no tools;
- GitHub MCP read-only tool turn;
- Developer Briefing workflow run;
- failed/denied tool attestation path;
- long SSE turn with client disconnect;
- burst of oversized/rate-limited requests.

### How to run

The harness is Node stdlib only (`fetch`, `perf_hooks`, `crypto`); no k6 or
Artillery dependency is needed. It mints NextAuth session cookies for seeded
synthetic users from `NEXTAUTH_SECRET` (the same derivation as
`next-auth/jwt`), so no credentials are stored; `--cookie` runs everything as
one existing session instead.

```sh
# 1. Seed 1k synthetic users into the target database (idempotent; --clean removes them).
DATABASE_URL=postgres://aihub:aihub_dev@localhost:5432/aihub \
  pnpm --filter @ai-workspace/web seed:load-users
# 2. Start a production server the way the authenticated smoke lane does
#    (see the header of scripts/load/pilot-load.mjs for the full env block).
# 3. Run; add --db-url to sample pg_stat_activity through psql.
pnpm load:pilot --db-url postgres://aihub:aihub_dev@localhost:5432/aihub
pnpm load:pilot --help
```

Results print as a table plus threshold verdicts and land as JSON under
`tmp/load/` (untracked). Against a non-loopback target the script refuses to
guess a secret: pass `NEXTAUTH_SECRET` or `--cookie`, run `health` and
`burst` first, then `chat` at `--chat-concurrency 5` before 25.
