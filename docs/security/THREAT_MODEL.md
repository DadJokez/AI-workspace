# Threat Model

This is a STRIDE-lite threat model for the deployed Comparative pilot. It
covers the browser application, ECS services, Postgres product store,
Bedrock/AgentCore runtime, connected tools, public-web capability, the
deployment path, and the CI merge gate that guards it. It does not claim
controls that are only planned.

Infrastructure claims here were re-verified against the live AWS account and
GitHub API on 2026-07-25. Where a control does not exist, this document says
so and links the issue that tracks it, rather than describing the intended
end state.

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
- External contributor opening a fork pull request against the public
  repository, whose branch content reaches CI and the automated reviewer.
- Malicious or compromised authenticated user.
- Compromised connected provider or OAuth token.
- Untrusted document, email, CRM record, web page, or tool response attempting
  indirect prompt injection.
- Compromised dependency, CI identity, task role, or AWS credential.
- Foundation model making an unsafe or incorrectly authorized tool decision.

## Trust boundaries

| Boundary | What crosses it | Primary controls | Residual risk |
|---|---|---|---|
| Internet -> ALB/web | Sessions, messages, uploads, invites, OAuth callbacks, webhooks | HTTPS redirect, NextAuth, invite gate, request/body limits, HMAC webhook verification, content validation | Public endpoint and public task networking; no WAF on the internet-facing ALB (#691); the application sends no security response headers — no CSP, HSTS, `nosniff`, or `frame-ancestors` outside the deployed-app sandbox routes (#693) |
| Web/worker -> Postgres | Product records, credentials, audit and run state | User/owner scoping, role checks, DB TLS, parameterized Drizzle/Postgres queries | RDS storage is unencrypted (#689) and the instance is publicly accessible with an undescribed console-only `0.0.0.0/0` ingress rule on 5432 (#690); coarse app DB credential; no DB-enforced audit immutability |
| Web/worker -> Bedrock/AgentCore | Prompt, context, attachments, tool schemas/results | AWS task IAM, bounded context, redaction, model registry, tool-iteration cap | `bedrock:InvokeModel*` resource is broad; cross-region profiles; no Bedrock Guardrail/DLP baseline |
| Runtime -> MCP/provider | Delegated token, tool arguments/results | Per-user token lookup, encrypted token store, attestation/catalog gate, provider validation, write-context controls where implemented | Tri-state policy/approval is not universal; provider compromise; broad outbound network |
| Runtime -> public web | Query, URL, fetched text | Explicit web capability, private/link-local/metadata address blocking, DNS/redirect re-checks, response caps, admin denylist, untrusted-content framing | Arbitrary public host egress; denylist rather than allowlist; public HTTP is permitted |
| Admin -> another user's data | Runs, threads, apps, feedback | `requireAdmin`, scoped support routes, `admin_data_access` receipts, justification header | Coarse admin role; no just-in-time elevation or dual control |
| CI/CD -> AWS production | Source commit, images, CDK, migrations, service updates | Protected PR gate (8 required contexts, `strict`, `enforce_admins`), commit-SHA tags with digest receipts, ECS circuit breaker, authenticated smoke, post-merge gate audit | Pipeline is not fully reconstructable in IaC (#467); production migration is pre-deploy and there is no staging environment to rehearse it in (#697); image tags are mutable (#449); see T16-T18 for the gate's own threats |

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
| T8 | Tampering / Repudiation | Modify or delete audit history after misuse | Application writes append-only audit rows, redacted receipts, run events, commit-tagged deploy receipts | DB credential can still update/delete rows; DB grants or tamper evidence pending #457; **authentication events are absent from the ledger entirely** (#694), so sign-in, denied sign-in, sign-out, and identity linking leave no trail |
| T9 | Tampering | Alter an app or artifact while claiming it is an older version | Immutable artifact version rows, app version pointers, ownership/share checks, restrictive deployed-app CSP | Concurrent edit/version integrity must remain covered by unique constraints and tests |
| T10 | Denial of service / Cost | Flood chat, uploads, web fetches, or tool loops | Shared Postgres fixed-window limits, 16 MiB request cap, per-file/type limits, response caps, eight tool iterations, worker leases, ECS circuit breaker | No WAF, team budget, provider quota, or autoscaling policy; one task per service |
| T11 | Information disclosure | Admin support access is invisible or excessive | Role gate, cross-owner `admin_data_access` receipts with target/resource/surface, five-minute noise dedupe, Audit UI | No JIT admin elevation, approval workflow, or SIEM export; receipt dedupe is best-effort |
| T12 | Information disclosure / Tampering | Compromised OAuth token performs provider actions | Per-user encrypted storage, minimum configured scopes, provider-specific validation, connect-time audit event | **There is no disconnect or revoke path (#692)** — `apps/web/app/api/oauth/*` exposes only `start`, `callback`, and `status`, so a user cannot withdraw access from inside Comparative and the encrypted token row survives provider-side revocation. Token rotation is provider-dependent; tri-state approval and connection-lifecycle audit pending #410 |
| T13 | Supply chain / Elevation | Malicious dependency, image, or CI identity reaches production | Lockfile, required `dependency CVE audit` check, PR CI/browser gate, independent Claude review, commit-tagged images, scoped CodeBuild role, CDK deployment | Known dependency findings require release triage; pipeline IaC gap is tracked in #467; image tags are mutable and both buildspecs push `latest` (#449). CI-specific threats are broken out as T16-T18 below |
| T14 | Availability / Data loss | RDS or an ECS service fails or is deleted | Health endpoint, ALB health checks, ECS circuit breaker, worker/5xx/run alarms, one-command commit-tag rollback, one-day RDS backups | Single-AZ, no deletion protection, no restore drill (procedure now written: `docs/runbooks/DB_RESTORE_REHEARSAL.md`), no staging environment to rehearse in (#697), and one memory alarm lacks SNS action |
| T15 | Repudiation / Residency | Inference leaves the expected region without a clear decision | AWS-only runtime and `us.*` Bedrock profiles | `us.*` is US cross-region, not `us-east-1` only; formal acceptance or single-region routing pending #492 |
| T16 | Spoofing / Elevation | An unreviewed commit is merged by asserting the review gate rather than earning it | `Claude verdict` is a commit status requiring `statuses: write`, not a PR comment (#459); `merge-gate-audit.yml` re-verifies the merged head's gate after every push to `main` | Any token with `statuses: write` on the repo can POST `context="Claude verdict"`, `state=success` for any SHA. Branch protection checks the context, never the author. The gate's integrity currently rests on the repo having exactly one collaborator (#698) |
| T17 | Supply chain / Elevation | An upstream GitHub Action is repointed and executes in a workflow holding secrets | `default_workflow_permissions: read`; least-privilege `permissions:` blocks per workflow; the review workflow checks out trusted default-branch code before untrusted PR code | Every action is referenced by mutable tag, not commit SHA (`actions/checkout@v6`, `anthropics/claude-code-action@v1`); `allowed_actions: all` and `sha_pinning_required: false`. `claude-code-review.yml` runs a tag-referenced third-party action with `CLAUDE_CODE_OAUTH_TOKEN` in scope (#698) |
| T18 | Elevation | A fork pull request reaches a privileged workflow context | `claude-verdict.yml` uses `pull_request_target` but never checks out PR code; `claude-code-review.yml` resolves its gate from trusted code before the untrusted checkout and grants the review only read-mostly tools; fork runs need approval for first-time contributors | The repository is public, so anyone can open a fork PR. `workflow_run` + untrusted checkout + secrets is the pwn-request shape; `approval_policy: first_time_contributors` gates a contributor's first PR only. Prompt injection via PR-authored files into the reviewing model is the realistic path, not code execution (#698) |

## CI and supply-chain threats

The merge gate in [`docs/AI_PR_REVIEW_PIPELINE.md`](../AI_PR_REVIEW_PIPELINE.md)
is a load-bearing security control: it is what stands between an
agent-authored change and a pipeline that deploys merged `main` straight to
production. It deserves the same honesty as the runtime controls, so T16-T18
above are stated as classes rather than folded into T13. Verified 2026-07-25.

**The repository is public.** That was decided deliberately on 2026-07-25 and
is a statement about the source, not the deployment. Consequences that matter
for this model:

- Nothing in the repository is secret, and nothing may become secret. The
  review rubric, the gate logic, the workflow files, and this threat model are
  all readable by an attacker designing a change to slip past review. The gate
  must be sound under full disclosure — obscurity was never a control here, and
  now it demonstrably is not one.
- Untrusted branches can reach CI. Fork pull requests run with a read-only
  token and no secrets on the `pull_request` trigger; the privileged surface is
  the `workflow_run`-triggered review workflow (T18).
- Actions secrets are unchanged by the visibility flip: `CLAUDE_CODE_OAUTH_TOKEN`
  is not exposed to fork-PR runs. The exposure is the follow-on privileged
  workflow, not the CI lane.

**The forgeable-verdict class (T16).** #459 fixed a real instance of this: the
review-happened fact used to be a PR comment, which anyone able to comment —
including a steered `@claude` session — could forge, so it moved to a
`Claude review completed` commit status that requires `statuses: write`. The
fix was correct and the class survives it. A commit status is an assertion by
whoever holds the write scope, and branch protection can require the *context*
but not the *author*. Today the practical mitigation is that
`gh api repos/DadJokez/AI-workspace/collaborators` returns one entry. That is a
membership fact, not a mechanism, and it should be re-examined the moment a
second write-access identity — human or machine — is added. Detection-side
hardening (asserting the status creator in `scripts/verify-pr-gate.sh`) is the
cheap next step and is tracked in #698.

**What the audit backstop can and cannot see.** `merge-gate-audit.yml` runs
its protection-presence canary unconditionally, but the finer checks (required
contexts, `enforce_admins`) need repo Administration read, which `GITHUB_TOKEN`
cannot be granted. Those degrade to best-effort. This is stated in the workflow
header and repeated here so the packet does not overclaim: the backstop makes a
silent bypass impossible, not a bypass impossible.

## Authentication and identity decisions

**`allowDangerousEmailAccountLinking: true` on the GitHub provider**
(`apps/web/lib/auth/nextauth.ts:191`) is deliberate, and the name is alarming
enough to deserve an explicit accepted-risk entry rather than a code comment.

*What it does.* NextAuth normally refuses to attach an OAuth identity to an
existing user when no account row already links them, to prevent an attacker
who controls an OAuth account with a victim's email address from taking over
that user. This flag disables that refusal for GitHub.

*Why it is set.* Comparative's identity anchor is the invite-gated email
address. A user created via magic link has no GitHub account row, so without
the flag the GitHub button returns `OAuthAccountNotLinked` for every
magic-link-first user. The flag is what makes both configured sign-in methods
work against one account.

*Why it is acceptable here.* The takeover this flag normally protects against
requires an attacker to control a GitHub account whose primary email is the
victim's — which requires GitHub to have verified that address to the attacker.
The `signIn` gate runs on both providers regardless and admits only a
first-ever signup, an existing user, or an address with a pending invitation,
so an uninvited stranger gains nothing from linking. GitHub is the only OAuth
sign-in provider configured; the flag is not set globally.

*What would invalidate this.* Adding a sign-in provider that does not verify
email ownership, or dropping the invite gate, breaks the reasoning above. The
PingOne/enterprise-IdP cutover (#491) should retire the flag rather than
inherit it. Until then, identity linking leaves **no audit record** — there is
no `auth.account_linked` event, and no authentication event of any kind, which
is the weakest part of this decision and is tracked in #694.

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
   single-AZ, and not storage encrypted; its security group carries a
   console-only `0.0.0.0/0` rule on 5432; ECS tasks are public with broad
   outbound access and no WAF at the edge. Track:
   [#689](https://github.com/DadJokez/AI-workspace/issues/689) (storage
   encryption), [#690](https://github.com/DadJokez/AI-workspace/issues/690)
   (ingress rule + IaC drift),
   [#691](https://github.com/DadJokez/AI-workspace/issues/691) (WAF),
   [#492](https://github.com/DadJokez/AI-workspace/issues/492) (perimeter epic).
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
   complete CodeBuild/webhook/ECR pipeline is not reconstructable from source,
   and there is no non-production environment to rehearse a deploy, migration,
   or restore in. Track:
   [#467](https://github.com/DadJokez/AI-workspace/issues/467),
   [#697](https://github.com/DadJokez/AI-workspace/issues/697).
6. **Provider access withdrawal:** a user cannot disconnect a connected
   provider from inside Comparative, and no authentication event reaches the
   audit ledger. Track:
   [#692](https://github.com/DadJokez/AI-workspace/issues/692),
   [#694](https://github.com/DadJokez/AI-workspace/issues/694).
7. **Merge-gate integrity:** the required `Claude verdict` status is
   forgeable by any holder of repo `statuses: write`, and workflow actions are
   pinned to mutable tags. Track:
   [#698](https://github.com/DadJokez/AI-workspace/issues/698).

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
