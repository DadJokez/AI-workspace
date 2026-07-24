# Threat Model

This is a STRIDE-lite threat model for the deployed Comparative pilot. It
covers the browser application, ECS services, Postgres product store,
Bedrock/AgentCore runtime, connected tools, public-web capability, and
deployment path. It does not claim controls that are only planned.

## Security objectives

1. A user can read or modify only their own data or data explicitly shared
   with them.
2. A model or tool never receives another user's credential.
3. Untrusted content is treated as data, not authority to expand tool access
   or override policy.
4. Sensitive actions are attributable through run events and the audit ledger.
5. A secret, provider, model, or runtime failure fails closed where private
   data would otherwise be disclosed.
6. Operators can detect, contain, recover, and explain a production incident.

## Protected assets

| Asset | Class | Consequence if compromised |
|---|---|---|
| OAuth tokens, database credentials, session/encryption secrets | Restricted | External account access, session forgery, database compromise |
| Chats, uploads, artifacts, apps, memory, feedback screenshots | Confidential | User/company data disclosure or integrity loss |
| Provider records returned by tools | Confidential | Mail, calendar, source, CRM, or workspace disclosure |
| User/share/attestation/policy state | Confidential security metadata | Cross-user access or unauthorized side effects |
| Audit rows, run events, trace snapshots, deploy receipts | Internal/Confidential evidence | Repudiation, impaired forensics, misleading incident record |
| Runtime availability and model budget | Operational | User outage, runaway spend, missed scheduled work |

## Actors

- Authenticated user.
- Workspace admin/support operator.
- Invited but not yet authenticated user.
- External attacker with no account.
- Malicious or compromised authenticated user.
- Compromised connected provider or OAuth token.
- Untrusted document, email, CRM record, web page, or tool response attempting
  indirect prompt injection.
- Compromised dependency, CI identity, task role, or AWS credential.
- Foundation model making an unsafe or incorrectly authorized tool decision.

## Trust boundaries

| Boundary | What crosses it | Primary controls | Residual risk |
|---|---|---|---|
| Internet -> ALB/web | Sessions, messages, uploads, invites, OAuth callbacks, webhooks | HTTPS redirect, NextAuth, invite gate, request/body limits, HMAC webhook verification, content validation | Public endpoint and public task networking; no WAF documented |
| Web/worker -> Postgres | Product records, credentials, audit and run state | User/owner scoping, role checks, DB TLS, parameterized Drizzle/Postgres queries | Public/unenciphered RDS storage, coarse app DB credential, no DB-enforced audit immutability |
| Web/worker -> Bedrock/AgentCore | Prompt, context, attachments, tool schemas/results | AWS task IAM, bounded context, redaction, model registry, tool-iteration cap | `bedrock:InvokeModel*` resource is broad; cross-region profiles; no Bedrock Guardrail/DLP baseline |
| Runtime -> MCP/provider | Delegated token, tool arguments/results | Per-user token lookup, encrypted token store, attestation/catalog gate, provider validation, write-context controls where implemented | Tri-state policy/approval is not universal; provider compromise; broad outbound network |
| Runtime -> public web | Query, URL, fetched text | Explicit web capability, private/link-local/metadata address blocking, DNS/redirect re-checks, response caps, admin denylist, untrusted-content framing | Arbitrary public host egress; denylist rather than allowlist; public HTTP is permitted |
| Admin -> another user's data | Runs, threads, apps, feedback | `requireAdmin`, scoped support routes, `admin_data_access` receipts, justification header | Coarse admin role; no just-in-time elevation or dual control |
| CI/CD -> AWS production | Source commit, images, CDK, migrations, service updates | Protected PR gate, immutable commit tags, deployment receipts, ECS circuit breaker, authenticated smoke | Pipeline is not fully reconstructable in IaC (#467); production migration is pre-deploy |

## Abuse cases and controls

| ID | STRIDE | Threat path | Current controls | Residual risk / required action |
|---|---|---|---|---|
| T1 | Spoofing | Forge a session or reuse an invite/magic link | Signed JWT cookie, HTTPS, random invite token, hashed single-use magic-link token, short magic-link expiry, invite-gated sign-in, rate limits | Rotate `NEXTAUTH_SECRET` on exposure; enterprise IdP and SCIM are not live |
| T2 | Spoofing / Repudiation | Forge or replay an event-trigger webhook | GitHub HMAC validation, delivery-id uniqueness, durable delivery receipt, trigger rate limit | Add source-specific controls before accepting another webhook provider |
| T3 | Elevation / Information disclosure | Change a resource id to read or write another user's data | Canonical `getSessionUser`, owner-scoped queries, 404-style non-disclosure, app/share role resolvers, real-Postgres scoping tests | Coarse admin bypass remains; every new route needs positive and negative scope tests |
| T4 | Elevation | A shared skill/app uses the owner's credential for another user | Execution re-resolves the acting user's OAuth token and attestations; shares do not copy credentials | Preserve this invariant when adding app live-data writes or shared scheduled runs |
| T5 | Tampering / Elevation | Uploaded/provider/web content tells the model to ignore policy or call a dangerous tool | Nonce-delimited untrusted-content framing, attachment secret scan, tool catalog/attestation gate, eight-iteration cap, result redaction | Universal enforce-mode write policy and Bedrock Guardrails/DLP are pending #410/#492 |
| T6 | Information disclosure | Secret appears in a prompt, tool result, log, trace, or artifact | Secrets live outside prompts, OAuth ciphertext at rest, payload redaction, trace byte/redaction limits, secret scan for uploads/artifacts, credentialed URLs rejected | Application log coverage must be reviewed continuously; RDS storage itself is unencrypted |
| T7 | Information disclosure / SSRF | Web fetch reaches metadata, localhost, or a private service | Scheme validation, credential rejection, DNS resolution and guarded lookup, redirect revalidation, private/link-local/metadata blocking, byte/time/redirect caps | Public-host egress is broad and HTTP is allowed; private subnet + egress controls pending #492 |
| T8 | Tampering / Repudiation | Modify or delete audit history after misuse | Application writes append-only audit rows, redacted receipts, run events, immutable deploy tags | DB credential can still update/delete rows; DB grants or tamper evidence pending #457 |
| T9 | Tampering | Alter an app or artifact while claiming it is an older version | Immutable artifact version rows, app version pointers, ownership/share checks, restrictive deployed-app CSP | Concurrent edit/version integrity must remain covered by unique constraints and tests |
| T10 | Denial of service / Cost | Flood chat, uploads, web fetches, or tool loops | Shared Postgres fixed-window limits, 16 MiB request cap, per-file/type limits, response caps, eight tool iterations, worker leases, ECS circuit breaker | No WAF, team budget, provider quota, or autoscaling policy; one task per service |
| T11 | Information disclosure | Admin support access is invisible or excessive | Role gate, cross-owner `admin_data_access` receipts with target/resource/surface, five-minute noise dedupe, Audit UI | No JIT admin elevation, approval workflow, or SIEM export; receipt dedupe is best-effort |
| T12 | Information disclosure / Tampering | Compromised OAuth token performs provider actions | Per-user encrypted storage, disconnect/revoke path, minimum configured scopes, provider-specific validation, audit events | Token rotation is provider-dependent; tri-state approval and connection-lifecycle audit pending #410 |
| T13 | Supply chain / Elevation | Malicious dependency, image, or CI identity reaches production | Lockfile, dependency audit, PR CI/browser gate, independent Claude review, immutable images, scoped CodeBuild role, CDK deployment | Known dependency findings require release triage; pipeline IaC gap is tracked in #467 |
| T14 | Availability / Data loss | RDS or an ECS service fails or is deleted | Health endpoint, ALB health checks, ECS circuit breaker, worker/5xx/run alarms, immutable rollback, one-day RDS backups | Single-AZ, no deletion protection, no restore drill, and one memory alarm lacks SNS action |
| T15 | Repudiation / Residency | Inference leaves the expected region without a clear decision | AWS-only runtime and `us.*` Bedrock profiles | `us.*` is US cross-region, not `us-east-1` only; formal acceptance or single-region routing pending #492 |

## Authorization invariants

- `session.user.id` maps to `users.id`; caller-supplied user IDs never establish
  identity.
- Normal reads and writes use owner scope. Admin cross-owner reads use explicit
  admin routes or scoped helpers and create `admin_data_access` receipts.
- A share grants the documented app/skill role only. It never grants a
  credential, connection, or attestation.
- Tool mounting is resolved for the acting user on each turn. A model cannot
  mount a provider solely by naming it.
- Provider responses, files, stored artifacts, email/CRM content, and fetched
  web pages are untrusted data.
- Restricted secrets must not appear in prompts, model-visible tool results,
  audit payloads, run traces, application logs, or URLs.
- A read-side authorization helper must not be reused for a write unless its
  write semantics are explicitly equivalent and tested.

## Highest residual risks

1. **Data-store perimeter and at-rest protection:** pilot RDS is public,
   single-AZ, and not storage encrypted; ECS tasks are public with broad
   outbound access. Track: [#492](https://github.com/DadJokez/AI-workspace/issues/492).
2. **Tool-side-effect policy:** provider attestations exist, but universal
   allow/approval/block enforcement is not live. Track:
   [#410](https://github.com/DadJokez/AI-workspace/issues/410).
3. **Audit tamper resistance:** append-only is an application convention, not
   a database guarantee. Track:
   [#457](https://github.com/DadJokez/AI-workspace/issues/457).
4. **Retention and deprovisioning:** approved windows, hard deletion, legal
   hold, and IdP deprovisioning are not implemented. Track:
   [#460](https://github.com/DadJokez/AI-workspace/issues/460).
5. **Pipeline recovery:** application infrastructure is CDK-managed, but the
   complete CodeBuild/webhook/ECR pipeline is not reconstructable from source.
   Track: [#467](https://github.com/DadJokez/AI-workspace/issues/467).

## Review and test obligations

- Add a unit or integration test for every new authorization boundary and its
  denied path.
- Add/update an audit-surface test for every privileged mutation or sensitive
  cross-owner read.
- Run dependency audit, lint, typecheck, unit/integration tests, build, and
  browser product smoke before merge.
- Re-run this threat model when a data class, trust boundary, provider,
  execution lane, identity method, or deployment perimeter changes.
- Security owner records accepted residual risk; engineering does not silently
  convert a backlog item into an accepted risk.
