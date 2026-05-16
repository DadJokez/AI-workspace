# Enterprise Readiness

This document turns epic #42 into operating decisions. It is deliberately
plain-spoken: some controls are shipped, some are pilot-grade, and some need
IT-owned infrastructure before broad rollout.

## Current Status

| Area | Status | Notes |
|---|---|---|
| Dependency audit | Partial | Next.js, Cursor SDK, Bedrock SDK, Drizzle, PostCSS, and PrismJS patches/overrides applied. Remaining audit findings are transitive and tracked below. |
| Health checks | Pilot shipped | `/api/health` checks DB connectivity/latency and runtime configuration. |
| Rate limits and quotas | Pilot shipped | `/api/chat` and Developer Briefing enforce process-local request limits and body/message caps. Move to shared storage before ECS scale-out. |
| Logging/redaction/retention | Policy defined | Code still needs a redaction helper before more integrations are added. |
| KMS/Secrets/IaC | Plan defined | Current App Runner env vars are acceptable for POC only. ECS/Fargate target requires Secrets Manager/KMS and IaC. |
| Load-test model | Model defined | Synthetic scenarios and thresholds are ready for a follow-up test harness. |

## Dependency Audit

Run from repo root:

```bash
pnpm audit:prod
```

Current triage after package patches:

| Finding | Source | Decision |
|---|---|---|
| Next.js advisories | `next` | Fixed by pinning `next` / `eslint-config-next` to `15.5.18`. |
| AWS XML parser advisory | `@aws-sdk/client-bedrock-runtime` path | Reduced by upgrading Bedrock SDK to `3.1048.0`; monitor upstream until `pnpm audit:prod` is clean. |
| Cursor SDK / `undici` advisories | `@cursor/sdk -> @connectrpc/connect-node -> undici@5.29.0` | Accepted temporarily. AI Hub does not choose this transitive dependency directly. Recheck when Cursor SDK releases a patched dependency tree. |
| `tar` / `sqlite3` advisories | `drizzle-orm` and `@cursor/sdk` optional/native dependency paths | Accepted temporarily for production runtime with mitigation: do not unpack untrusted archives at runtime; keep lockfile pinned; revisit removing optional SQLite paths or upstream updates. |
| PostCSS advisory | `next -> postcss` | Mitigated with a pnpm override to `postcss@8.5.10`. |
| `prismjs` advisory | `react-syntax-highlighter -> refractor -> prismjs` | Mitigated with a pnpm override to `prismjs@1.30.0`; assistant markdown rendering still avoids raw HTML. |

Acceptance is not "ignore forever." The review cadence is:
- run `pnpm audit:prod` before production release candidates;
- upgrade direct dependencies first;
- document any remaining transitive finding with owner, mitigation, and next
  review date;
- fail the release on critical findings or on reachable high findings without
  a mitigation.

## Health Checks

`GET /api/health` returns:

```json
{
  "status": "ok",
  "service": "ai-workspace-web",
  "timestamp": "2026-05-16T00:00:00.000Z",
  "checks": {
    "db": { "ok": true, "latencyMs": 12 },
    "runtime": { "ok": true, "name": "cursor", "configured": true }
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
- `CHAT_MAX_REQUEST_BYTES`: maximum request body size before parsing.
- `CHAT_MAX_MESSAGE_CHARS`: maximum user message length.
- `CHAT_RATE_LIMIT_WINDOW_MS`: fixed-window duration.
- `CHAT_RATE_LIMIT_REQUESTS`: per-user request count in the window.

The same limiter protects `/api/chat` and the manual Developer Briefing route.
Developer Briefing gets one third of the chat request allowance because it can
perform tool work.

Important limitation: this limiter is process-local. It is enough for pilot
protection on App Runner, but ECS/Fargate scale-out needs a shared limiter,
preferably Redis/Valkey or another central store. Enterprise quota work should
add:
- per-user daily token budgets;
- per-team/provider quotas;
- model-specific output-token caps;
- tool iteration caps per run;
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

Retention targets:

| Data | Pilot retention | Enterprise target |
|---|---|---|
| Chat messages | Until user/admin delete | 1 year default, configurable by policy |
| Audit log | Indefinite in pilot | 7 years or IT/compliance requirement |
| Recipe runs | Until manual cleanup | 1 year outputs, 7 years metadata/audit |
| Runtime debug logs | CloudWatch default | 30-90 days |
| OAuth tokens | Until disconnect/revocation | Until disconnect/revocation; rotate where provider supports it |
| Future S3/Athena Agent Wire | Not live | Lifecycle policy by data classification |

Follow-up code work: add a shared redaction helper and apply it to
`process.stderr` runtime logs before onboarding more tool providers.

## Secrets, KMS, And IaC

POC state:
- App Runner environment variables hold app/runtime secrets.
- OAuth tokens are encrypted in Postgres with AES-256-GCM using
  `OAUTH_ENCRYPTION_KEY`.
- Infrastructure was created manually plus CodeBuild/App Runner automation.

Enterprise target:
- ECS/Fargate task definitions read secrets from AWS Secrets Manager.
- KMS customer-managed keys protect Secrets Manager values and any future
  application-level envelope encryption.
- IaC owns ECS service, ALB, IAM roles, Secrets Manager/KMS, RDS, alarms, and
  networking.
- CI/CD assumes a deploy role rather than using broad long-lived credentials.

Secrets inventory:

| Secret | Current | Enterprise target |
|---|---|---|
| `NEXTAUTH_SECRET` | App Runner env | Secrets Manager, rotate on incident |
| `CURSOR_API_KEY` | App Runner env | Secrets Manager, service-owned Cursor key |
| `DATABASE_URL` | App Runner env / CodeBuild | Secrets Manager dynamic reference |
| `OAUTH_ENCRYPTION_KEY` | App Runner env | KMS-backed secret, rotation plan required |
| `GITHUB_AUTH_CLIENT_SECRET` | App Runner env | Secrets Manager |
| `GITHUB_CLIENT_SECRET` | App Runner env | Secrets Manager |
| AWS deploy credentials | CodeBuild role | Least-privilege deploy role in IaC |

## Load-Test Model

These are planning assumptions, not measured results yet.

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
