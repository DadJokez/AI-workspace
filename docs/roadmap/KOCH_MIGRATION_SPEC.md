# Koch firewall migration — implementation spec for coding agents

Companion to [`KOCH_FIREWALL_PLAN.md`](KOCH_FIREWALL_PLAN.md) (the why and the order). This file is the
**how**: twenty work packages, each sized to be one pull request that a coding model can build without
further design input (WP-07 is documents only). Epic #970. Written 2026-11-13 from `main` @ `0ad34bf`.

Line references were read from the code on that commit. They drift; re-read the file before editing it.

---

## 0. Rules for whoever builds this

1. **One work package (WP) = one branch = one pull request.** Branch from fresh `origin/main`, name it
   `koch/wp-NN-<slug>`. PR body: what changed, validation actually run (paste results), risks,
   human-owned items at the top, `Refs #<issue>` (use `Closes` only when the WP is the whole issue).
2. **You never change live infrastructure.** No `terraform apply`, no `aws` write calls, no secret values,
   no DNS, no database writes outside the test database. Anything that needs those is listed under
   **Rob runs** in the WP and goes in the PR body as exact commands.
3. **CLAUDE.md §7 applies to almost every WP.** Migrations, IAM, secrets, env, auth surface, new
   production dependencies: build them, flag them at the top of the PR, and expect `needs-rob`.
4. **Do not edit `infra/cdk/`, `buildspec*.yml` or `infra/scripts/` until WP-20.** Terraform is built
   beside CDK. Production keeps deploying the old way until Rob cuts over.
5. **No behaviour change in production unless the WP says so.** New configuration defaults must reproduce
   today's behaviour; the Koch behaviour is opt-in through environment variables.
6. **Local gate before pushing:** `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. On Node 24 the
   unit suite needs `NODE_OPTIONS=--no-experimental-webstorage`. Terraform WPs also run
   `terraform fmt -check -recursive && terraform validate` per stack and the policy job locally.
7. **Migrations** are handwritten SQL plus a journal entry (ADR 0008). Next free number is `0053`. The
   journal `when` must be greater than the previous entry's (`1788994109000` for `0052`), or the migration
   silently never runs. They must pass `packages/db/scripts/migration-guard.mjs` (expand-only).
8. **Honesty spine.** Any WP that can remove a capability (a connector, web search, analytics) must also
   remove it from the model's capability statement and add an eval case proving the assistant does not
   claim it.
9. **If the spec is wrong about the code, the code wins.** Say so in the PR body and adjust; do not force
   the code to match a stale line reference.
10. **YAGNI.** Build what the WP lists. No extra variables, modules, or abstractions "for later".

### Suggested model per WP

| Model | Use for | WPs |
|---|---|---|
| Sonnet | Mechanical, fully specified, low blast radius | 01, 02, 05, 07, 08, 10, 12, 16, 19 |
| Opus | Cross-cutting, security-sensitive, or needs judgment about existing code | 03, 04, 06, 09, 11, 13, 14, 15, 17, 18, 20 |

### Dependency graph

```
WP-01 ─┬─ WP-02
       ├─ WP-03 ── WP-04 ── WP-05 ── WP-06 (optional until WP-19)
       └─ WP-17 ── WP-18
WP-08 ── WP-09 ── WP-10 ── WP-11 ── WP-12
                    └────── WP-13 (needs WP-01, WP-11)
WP-08 ── WP-14 ── WP-15 ── WP-16
WP-19 needs 03, 04, 05, 09–13, 15        WP-20 needs 08–16        WP-07 stands alone
```
Tracks that can run in parallel from day one: **app** (01→06), **identity** (17→18 after 01),
**Terraform** (08→13), **pipeline** (14→16 after 08).

---

## 1. Fixed decisions, names, versions

**Decisions (Rob, 2026-11-12):** Koch-vended AWS account per environment; GitHub Enterprise; ECS Fargate;
Ping OIDC with magic links kept temporarily; connectors Microsoft 365, Salesforce, GitHub Enterprise;
one Koch-wide instance; personal account stays as the cheap sandbox on the same Terraform.
**Open:** Terraform Enterprise vs S3 state (build for S3, keep it swappable); cross-region Bedrock
inference (build it as a variable).

**Environments.** One directory per deployed environment under `infra/terraform/envs/`. (The plan's
generic dev/stage/prod become these concrete names.)

| Directory | Account | Purpose | Profile |
|---|---|---|---|
| `personal-stage` | personal | Every merge deploys here first | cheapest: single-AZ, 1 task each, `firewall_mode=false` |
| `personal-prod` | personal | Replaces today's CDK production (the sandbox) | cheap: matches PR #963's idle profile |
| `personal-rehearsal` | personal | Created for a firewall rehearsal, then destroyed | `firewall_mode=true`, `internal_alb=true` |
| `koch-dev`, `koch-stage`, `koch-prod` | Koch | Added in #985; not part of this spec's build | adopt-mode network |

**Naming.** Every resource name is `${var.name_prefix}-<thing>` where `name_prefix = "cmp-<env>"`
(for example `cmp-personal-stage-web`). No fixed names. This lets Terraform and CDK coexist in the
personal account. Secrets: `comparative/<env>/<name>`. SSM parameters: `/comparative/<env>/<stack>/<key>`.
Log groups: `/comparative/<env>/<service>`.

**Tags** (provider `default_tags`): `app=comparative`, `env`, `owner`, `cost-center`, `data-class`,
`managed-by=terraform`, `repo`.

**Versions.** Terraform `~> 1.17` (needs ≥ 1.11 for S3 native locking and write-only arguments).
AWS provider `~> 6.73` (has `aws_bedrockagentcore_agent_runtime`, `_agent_runtime_endpoint`, `_browser`,
`_api_key_credential_provider`, `_workload_identity`; verified against the provider docs 2026-11-13).
Commit `.terraform.lock.hcl` for `linux_amd64`, `linux_arm64`, `darwin_arm64`.

**State.** S3 backend, `use_lockfile = true`, SSE-KMS, versioned bucket
`comparative-tfstate-<account_id>-<region>`, key `<env>/<stack>.tfstate`. No `terraform_remote_state`:
stacks publish outputs to SSM Parameter Store and downstream stacks read them with `aws_ssm_parameter`
data sources. That keeps a later move to Terraform Enterprise a backend-only change.

---

## 2. The configuration contract

Today there is no central config module: about 70 `process.env.*` names are read ad hoc, and
`PUBLIC_BASE_URL` lives in `apps/web/lib/oauth/github.ts:9-11` with the personal domain as its fallback.
After WP-01 to WP-05 the contract below is the complete list of deployment-specific inputs. "Today" is
the value production must keep receiving so nothing changes there.

| Variable | Consumers | Required | Today (personal prod) | Koch | Added by |
|---|---|---|---|---|---|
| `NEXTAUTH_URL` | web, workers, smoke | yes in production | `https://comparative.builtwithrobot.link` | Koch DNS name | exists; WP-01 removes the code fallback |
| `INTERNAL_BASE_URL` | web, workers (handed to AgentCore) | no | unset | internal ALB URL | WP-01 |
| `AWS_REGION` | all | yes | `us-east-1` | per account | exists |
| `BEDROCK_INFERENCE_PROFILE_PREFIX` | web, workers, agent container, evals | no (default `us.`) | `us.` | per residency answer | WP-02 |
| `AGENTCORE_RUNTIME_ARN` | chat-worker | when `RUNTIME=agentcore` | hard-coded in CDK | from SSM | exists |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | all | no | unset | Koch proxy | WP-03 |
| `ENABLED_CONNECTOR_PROVIDERS` | web, workers | no (default: all configured) | unset | `salesforce,github` (+`microsoft` later) | WP-04 |
| `WEB_SEARCH_PROVIDER` | web, workers, agent container | no | `brave` | `none` | exists; WP-04 adds `none` |
| `WEB_FETCH_ENABLED` | web, workers, agent container | no (default `1`) | unset | per egress answer | WP-04 |
| `ANALYTICS_PROVIDER` | web | no (default `none`) | `posthog` (set explicitly) | `none` | WP-04 |
| `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST` | web | when analytics is `posthog` | today baked into the image | unset | WP-04 |
| `GITHUB_WEB_URL`, `GITHUB_API_URL`, `GITHUB_MCP_URL` | web, workers | no (default github.com values) | unset | GitHub Enterprise hosts | WP-05 |
| `GITHUB_EVENT_INGEST_MODE` | web, chat-worker | no (default `webhook`) | unset | `poll` | WP-06 |
| `AUTH_PROVIDERS` | web | no (default `github,email`) | unset | `pingone,email` then `pingone` | exists; WP-17 adds `pingone` |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SCOPES`, `OIDC_GROUPS_CLAIM`, `OIDC_ADMIN_GROUP`, `OIDC_REQUIRED_GROUP`, `OIDC_ADOPT_EMAIL_USERS` | web | when `pingone` is enabled | unset | Ping values | WP-17 |
| `MAGIC_LINK_ALLOWED_DOMAINS`, `MAGIC_LINK_SUNSET` | web | no | unset (no restriction) | set | WP-17 |
| `SESSION_MAX_AGE_SECONDS`, `SESSION_UPDATE_AGE_SECONDS` | web | no (defaults = today's 24 h / 1 h) | unset | per IdP policy | WP-17 |

Secrets stay as JSON fields of one Secrets Manager secret per environment (`comparative/<env>/app`), with
the same field names production uses today (`infra/cdk/lib/ai-workspace-ecs-stack.ts:18-34`), plus
`OIDC_CLIENT_SECRET` and `POSTHOG_PROJECT_TOKEN` when used.

---

# Part A — Application portability (issues #972, #973)

## WP-01 — Deployment config module, base URLs, no personal-domain fallback

**Issue** #972 · **Model** Sonnet · **Depends on** nothing

**Why.** `PUBLIC_BASE_URL` falls back to `https://comparative.builtwithrobot.link`
(`apps/web/lib/oauth/github.ts:9-11`) and is imported from an OAuth file by 15+ modules. Inside the
firewall the AgentCore runtime must call the app's MCP facades over an internal address, but each facade
rejects any host that is not the public one (`validateSameOrigin`, `apps/web/lib/google/mcp.ts:181-200`;
same pattern at `lib/salesforce/mcp.ts:221`, `lib/notion/mcp.ts:99`, `lib/conversation-resource-mcp.ts:370`,
`lib/oauth/mcp-servers.ts:685-711`).

**Create**
- `apps/web/lib/deployment-config.ts` exporting:
  - `PUBLIC_BASE_URL: string` — `NEXTAUTH_URL` without trailing slash. If unset: throw when
    `NODE_ENV === "production"`; otherwise `http://localhost:3000`.
  - `INTERNAL_BASE_URL: string | null` — from `INTERNAL_BASE_URL`, validated as an absolute http(s) URL.
  - `serverCallbackBaseUrl(): string` — `INTERNAL_BASE_URL ?? PUBLIC_BASE_URL`. The address a
    **server-side** caller (worker, AgentCore runtime) uses to reach this app.
  - `isAllowedAppHost(host: string): boolean` — true for the public host and, when set, the internal host
    (case-insensitive, compare `URL.host`).
  - `assertDeploymentConfig(): void` — validates everything above plus `AWS_REGION` presence when
    `BEDROCK_CLIENT === "real"`; throws one error naming every missing or malformed variable.
- `apps/web/instrumentation.ts` with `register()` calling `assertDeploymentConfig()` on the Node runtime
  (there is only `instrumentation-client.ts` today). Call the same function at the top of
  `apps/web/scripts/chat-run-worker.ts`, the memory-capture worker script, and the browser egress proxy
  script.

**Modify**
- Delete `DEFAULT_PUBLIC_BASE_URL`/`PUBLIC_BASE_URL` from `lib/oauth/github.ts`; update every importer to
  `@/lib/deployment-config` (find them with `grep -rn "PUBLIC_BASE_URL" apps/web`). No re-export shim.
- MCP facade endpoint URLs handed to the runtime (`lib/oauth/mcp-servers.ts:94, 98, 669`) use
  `serverCallbackBaseUrl()`. OAuth redirect URIs and anything a browser follows keep `PUBLIC_BASE_URL`.
- Replace the five host checks listed above with `isAllowedAppHost`. Keep each check's existing error
  shape and status code. The `x-forwarded-host` check uses the same helper.
- `scripts/production-smoke.mjs:1` and `apps/web/scripts/production-auth-smoke.ts:22`: remove the default
  URL; require `SMOKE_BASE_URL` and exit non-zero with a clear message if absent. Leave the workflow
  default in `.github/workflows/product-smoke.yml` as is (it is the personal environment's config).

**Tests**
- Unit: `deployment-config.test.ts` — production without `NEXTAUTH_URL` throws; trailing slash stripped;
  internal URL validation; `isAllowedAppHost` for both hosts and a foreign host; `assertDeploymentConfig`
  aggregates multiple problems.
- Update the existing facade tests so a request with the internal host is accepted when
  `INTERNAL_BASE_URL` is set and rejected when it is not.
- Add one test proving the facade endpoint handed to the runtime is the internal URL when set, while
  `GOOGLE_REDIRECT_URI` etc. stay public.

**Acceptance**
- `grep -rn "builtwithrobot" apps/web/lib apps/web/app apps/web/scripts scripts` returns nothing.
- Full local gate green. No env var needs to change in production (it already sets `NEXTAUTH_URL`).

**Rob runs** nothing. Flag in the PR: the facade host check is a security control and now accepts a
second, operator-configured host.

## WP-02 — Inference-profile prefix, seeded-URL migration, portability guard test

**Issue** #972 · **Model** Sonnet · **Depends on** WP-01

**Why.** Nine registry entries hard-code the `us.` cross-region prefix
(`packages/agent/src/models.ts:153, 180, 207, 234, 283, 346, 373, 400, 705`); three migrations seeded the
personal domain into `mcp_servers.endpoint_url` (`packages/db/drizzle/0032…:17`, `0035…:17`, `0040…:17`).

**Build**
1. `packages/agent/src/models.ts`: add `resolveBedrockModelId(model, prefix = process.env.BEDROCK_INFERENCE_PROFILE_PREFIX ?? "us.")`.
   If the registry id starts with `us.`, swap that prefix for the configured one (`""`, `us.`, `global.`,
   `eu.` are valid; anything else throws at call time). Ids without a geo prefix are returned unchanged.
   Use it at the two send sites: `packages/agent/src/clients.ts:498` and
   `packages/agent/src/responses-client.ts:120`. Error messages that print the model id
   (`clients.ts:195`) print the resolved id.
2. Do **not** change prices. Add a comment at the top of the registry: prices are for the `us.` profile;
   other prefixes differ, and #944's cost work owns that.
3. Migration `0053_relative_mcp_endpoint_urls.sql`: `UPDATE mcp_servers SET endpoint_url = '/api/mcp/' || slug, updated_at = now() WHERE slug IN ('google','salesforce','notion') AND endpoint_url LIKE 'https://comparative.builtwithrobot.link/%';`
   plus the journal entry. Find every reader of `endpoint_url` (`grep -rn "endpointUrl\|endpoint_url" apps packages --include='*.ts*'`)
   and resolve a leading-slash value against `PUBLIC_BASE_URL` at read time. Runtime execution already
   builds these URLs from code (`lib/oauth/mcp-servers.ts`), so this is display/admin data only — confirm
   that in the PR body.
4. `apps/web/__tests__/portability-literals.test.ts`: run `git ls-files`, exclude `docs/`, `**/__tests__/**`,
   `*.test.*`, `infra/cdk/**`, `infra/scripts/**`, `buildspec*.yml`, `.github/workflows/**`,
   `packages/db/drizzle/00{32,35,40}_*.sql`, and fail if any remaining file contains `351478076796`,
   `builtwithrobot`, or `DadJokez/AI-workspace`. The exclusion list is the to-do list for later WPs; WP-20
   shrinks it.

**Tests** registry test covering each prefix and an un-prefixed id; integration test that the migration
rewrites only the three rows and is idempotent.

**Acceptance** gate green; evals mock lane unchanged; with the variable unset every resolved id equals
today's.

**Known limit — write it in the PR body.** Current Claude models on Bedrock are invoked through inference
profiles; an empty prefix may not be invocable on demand for them. This WP makes the prefix configurable;
it does not prove any non-`us.` value works. That is an intake question (#971).

**Rob runs** the migration ships with the normal deploy. `needs-rob` (migration).

## WP-03 — Proxy-aware outbound HTTP

**Issue** #973 · **Model** Opus · **Depends on** WP-01

**Why.** No code path honours a proxy today (no `ProxyAgent`, `HTTPS_PROXY` or custom handler anywhere).
Inside the firewall every non-AWS destination is reachable only through a forward proxy.

**Outbound paths to cover** (each must be exercised by the test):
1. Global `fetch` — OAuth token exchanges (`lib/oauth/google-token.ts`, `salesforce-token.ts`), provider
   APIs (`lib/google/api.ts`, `lib/salesforce/api.ts`, `lib/notion/mcp.ts`), SES (`lib/aws-ses.ts`),
   GitHub webhook subscriptions (`lib/github-webhook-subscriptions.ts`), web search
   (`packages/agent/src/web-search-tool.ts`), web fetch (`packages/agent/src/web-fetch-tool.ts`),
   the Bedrock Responses route (`packages/agent/src/responses-client.ts`).
2. AWS SDK v3 clients — `BedrockRuntimeClient` (`packages/agent/src/clients.ts:412`,
   `responses-client.ts:447`), `BedrockAgentCoreClient` (`lib/studio-browser.ts:469`,
   `packages/agent-runtime/src/agentcore-runtime.ts:50`, `apps/agentcore-agent/src/agentcore-api-key.ts:83`).
3. MCP client transport — `StreamableHTTPClientTransport` (`packages/agent/src/mcp.ts:183`).
4. NextAuth provider calls (GitHub today, OIDC after WP-17) and `posthog-node`.

**Approach (in this order; stop at the first that passes the test for all four paths)**
1. Runtime-native: run with `NODE_USE_ENV_PROXY=1` plus `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` on Node 24.
   Verify, do not assume, that it covers `fetch` **and** the `node:https` agent the AWS SDK and NextAuth use.
2. If `fetch` is covered but `node:https` is not: one bootstrap module
   `packages/agent/src/outbound-proxy.ts` (imported first by every entrypoint: web `instrumentation.ts`,
   worker scripts, proxy script, `apps/agentcore-agent/src/server.ts`) that installs a proxy-aware global
   agent. Prefer what is already in the dependency tree (`undici` ships with Node; check
   `pnpm why https-proxy-agent hpagent` before adding anything). A new production dependency is a §7 item.
3. `NO_PROXY` semantics must match what Terraform will supply: an explicit host list (the VPC endpoint
   hostnames, the internal ALB host, `169.254.170.2`, `localhost`). Do not special-case `.amazonaws.com`.

**Also**
- `fetchPublicUrl` in `web-fetch-tool.ts` does its own SSRF/redirect checks. Keep them; make sure the
  proxy does not weaken them (the tool must still refuse private addresses **before** connecting).
- Export `describeOutboundProxy(): { enabled: boolean; proxyHost: string | null; noProxy: string[] }` and
  log it once at boot (host only, never credentials).

**Tests**
- `apps/web/__tests__/outbound-proxy.integration.test.ts` under `vitest.integration.config.ts`: start a
  local CONNECT proxy that records hosts (the browser egress proxy in `lib/browser-egress-proxy.ts` is a
  usable fixture), set the env, and assert that one call per path above is seen by the proxy; a
  `NO_PROXY` host is not; and with the proxy stopped the calls fail with an error that names the proxy.
  Use local HTTPS stubs, never the internet.
- A static test that fails on a new `new XxxClient(` for an AWS SDK client or a new transport
  construction outside an allowlist of files, so later code cannot bypass the bootstrap silently.

**Acceptance** gate green; with no proxy variables set, behaviour and timings are unchanged.

**Rob runs** nothing. `needs-rob` only if a production dependency is added.

## WP-04 — Provider, web-search, web-fetch and analytics switches; PostHog out of the image

**Issue** #973 · **Model** Opus · **Depends on** WP-03

**Why.** The Koch build drops Google, Notion, Brave and PostHog. Today the provider list is a module
constant (`MCP_PROVIDER_CONFIG`, `apps/web/lib/oauth/mcp-servers.ts:87-101`), the PostHog token is baked
into two image stages (`apps/web/Dockerfile:34-35, 70-71`), and `/ingest/*` is a build-time rewrite
(`apps/web/next.config.mjs:136-148`).

**Build**
1. `ENABLED_CONNECTOR_PROVIDERS` (comma list; unset = every provider in `MCP_PROVIDER_CONFIG`). Apply it
   in one place so `SUPPORTED_MCP_PROVIDERS` and `MOUNTABLE_MCP_PROVIDERS` shrink, and follow every
   consumer: settings/connect UI, OAuth start and callback routes (a disabled provider's routes return
   404), tool catalog and discovery, `buildUserMcpServers`, the agent preamble and capability statement
   (`lib/agent-preamble.ts`, `lib/chat-context-pack.ts`), starter skills that require a disabled provider
   (hide them), onboarding steps. Unknown names in the variable fail `assertDeploymentConfig()`.
2. `WEB_SEARCH_PROVIDER=none`: the web-search tool is not registered; the AgentCore credential provider
   variable is not required. `WEB_FETCH_ENABLED=0`: the `web__fetch_url` tool is not registered. Both
   flow into the capability statement.
3. Analytics at runtime. Remove both `ENV NEXT_PUBLIC_POSTHOG_*` pairs from the Dockerfile. Server reads
   `ANALYTICS_PROVIDER`, `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST`. The root layout injects
   `{ analytics: { provider, token, apiHost: "/ingest" } | null }` for the client;
   `instrumentation-client.ts` initialises PostHog only when it is present. Replace the three rewrites
   with a route handler `apps/web/app/ingest/[...path]/route.ts` that proxies to the configured host
   (through the WP-03 outbound path) when analytics is on and returns 404 when off. Preserve the CSP
   comment and behaviour described at `next.config.mjs:25-26`. `lib/posthog-server.ts` becomes a no-op
   when off (no client constructed, no network).
4. Production must set `ANALYTICS_PROVIDER=posthog` and the token explicitly to keep today's behaviour.
   Put that in the PR body as a required env change **before** this merges.

**Tests**
- Unit: provider filter with unset / subset / unknown; preamble text for each switch.
- Playwright: with Google disabled, Settings shows no Google card and `/api/oauth/google/start` is 404.
- Eval cases (one file each under `packages/evals/src/cases/`): with all optional providers, search and
  fetch disabled, the assistant (a) does not offer to search the web or read mail, and (b) says plainly it
  cannot when asked. Deterministic assertions on tool calls; judge rubric naming its FAIL conditions.
- Unit: `/ingest/*` 404 when off; proxied when on (stub upstream).

**Acceptance** gate green; mock eval pack green; image built without analytics env contains no PostHog
token (`docker history` / grep the standalone output in CI).

**Rob runs** add `ANALYTICS_PROVIDER`, `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST` to the production task
environment/secret before merge. `needs-rob` (env, and the capability-statement change).

## WP-05 — GitHub host configuration and the egress inventory

**Issue** #973 · **Model** Sonnet · **Depends on** WP-04

**Build**
1. `GITHUB_WEB_URL` (default `https://github.com`), `GITHUB_API_URL` (default `https://api.github.com`),
   `GITHUB_MCP_URL` (default `https://api.githubcopilot.com/mcp/`; empty string = GitHub connector not
   mountable, with reason `execution_not_configured`). Replace the literals at `lib/oauth/github.ts:15-17`,
   `lib/github-webhook-subscriptions.ts:10`, `packages/agent/src/sources.ts:325`,
   `lib/oauth/mcp-servers.ts:89`, and the NextAuth GitHub provider (authorization, token, userinfo URLs)
   when the web URL is not github.com. Validate all three in `assertDeploymentConfig()`.
2. `apps/web/lib/egress-inventory.ts`: one exported array, each entry
   `{ host, purpose, services: ("web"|"chat-worker"|"memory-worker"|"agent-runtime"|"browser-proxy"|"browser")[], enabledWhen, viaProxy: boolean }`.
   Hosts derive from the same config the code uses (so a GitHub Enterprise host appears automatically).
   Include AWS service endpoints (`viaProxy: false`) and the user's browser destinations (OAuth consent
   pages, AgentCore live-view stream).
3. `pnpm egress:inventory` writes `docs/security/EGRESS_INVENTORY.md` (table, grouped by service, with
   the switch that removes each row). Also `--json` and `--allowlist` outputs: the allowlist is the exact
   proxy host list and the `NO_PROXY` list for a given environment's settings; Terraform and the Koch
   allowlist request both consume it.
4. Tests: the committed doc equals the generated one; a scanner over non-test source fails on any
   `https://<host>` literal whose host is not in the inventory or in a small ignore list (schema URLs,
   documentation links in comments).

**Acceptance** gate green; the doc lists every host from the survey: GitHub (web, API, MCP), Google
(accounts, oauth2, gmail, calendar), Notion (api, mcp), Salesforce (login + instance wildcard), Brave,
PostHog, SES, Bedrock runtime, AgentCore, Secrets Manager, CloudWatch Logs, arbitrary web fetch.

**Rob runs** nothing.

## WP-06 — Event triggers without public ingress (poll mode)

**Issue** #973 · **Model** Opus · **Depends on** WP-05 · **Optional until the WP-19 rehearsal is scheduled**

**Why.** GitHub event triggers need GitHub to POST to `app/api/webhooks/github/route.ts`, and the app
creates repository webhooks with the owner's token (`lib/github-webhook-subscriptions.ts:31, 123`). An
internal-only ALB cannot receive them from a GitHub that sits outside the network.

**Build**
- `GITHUB_EVENT_INGEST_MODE=webhook|poll` (default `webhook`).
- In `poll` mode: creating or enabling a trigger does not call `ensureGitHubRepositoryWebhook`; the
  chat-worker process runs a poller beside the scheduler (`apps/web/scripts/chat-run-worker.ts:40-55`)
  that, per distinct (owner token, repository) with an active trigger, calls
  `GET {GITHUB_API_URL}/repos/{owner}/{repo}/events` with `If-None-Match`, respects `X-Poll-Interval`,
  maps each event to the same normalized shape `normalizeGitHubWebhookEvent` produces
  (`lib/github-event-triggers.ts:185`), and hands it to the existing `processGitHubWebhookEvent`
  pipeline (`:349`) with the event id as the delivery id so the unique (trigger, delivery) key dedupes.
- Store the ETag and last-seen event id per (trigger) in the trigger's existing jsonb/config column if
  one exists; only add a column if there is nowhere to put it (then it is migration `0054`, §7).
- Leased like the scheduler so two workers do not poll the same repository.
- The webhook route returns 404 in poll mode.

**Tests** unit tests for the mapper against recorded GitHub event fixtures for each supported event type;
dedupe across two polls; ETag 304 path; lease contention; rate-limit backoff.

**Acceptance** an event-trigger eval or integration test passes in both modes with a stubbed GitHub API.

**Rob runs** nothing unless a migration is needed.

## WP-07 — Landing-zone contract, intake questions, and corrected security docs

**Issue** #971 · **Model** Sonnet · **Depends on** nothing · documents only

**Build**
1. `docs/roadmap/KOCH_INTAKE_QUESTIONS.md` — the questions Rob takes to the Koch platform team, grouped:
   accounts and regions; network (VPC ownership, subnets, DNS, certificates, allowed interface endpoints,
   outbound proxy address and allowlist process, inbound paths); GitHub Enterprise (org, hosted vs
   in-network runners, OIDC to AWS, required checks); Terraform (Enterprise vs S3 state, mandatory
   modules, policy sets, tagging standard); images (registry, base-image rules, scanning, signing);
   identity (Ping tenant, OIDC app registration, group claim name, SCIM); logging and SIEM; KMS key
   policy; Bedrock (model-access process, whether `us.` cross-region profiles are allowed, whether the
   existing Koch chat tool's gateway or quota must be used, Guardrails requirements); data classification
   allowed for a pilot; change management and security review steps; cost allocation.
2. `docs/adr/0015-koch-landing-zone-contract.md` — status Proposed. One table: question, answer or
   default, source, date, the Terraform variable or app variable it sets (use the names in §2 and Part B).
   Seed it with Rob's eleven answers from `KOCH_FIREWALL_PLAN.md` §0.
3. Correct `docs/security/README.md` posture table and any sibling statement that the database is
   unencrypted, public, on one-day backups, or without deletion protection. Verified live on 2026-11-13:
   `db.t4g.micro`, PostgreSQL 16.13, single-AZ, **encrypted, not publicly accessible, 7-day backups,
   deletion protection on**. Cite the date and say it is a point-in-time reading. Also fix
   `docs/PRODUCTION_DEPLOYMENT.md` "three ECS services" (there are four) and note at the top of
   `AWS_SETUP.md` that its Terraform reference is historical.
4. Record one decision in the ADR: **email inside the firewall stays on the SES HTTPS API through the
   proxy allowlist.** SES has a VPC interface endpoint only for SMTP; adding an SMTP client is a new
   production dependency and magic links are temporary, so no SMTP work is planned unless Koch refuses
   the allowlist entry. (This supersedes the SMTP bullet in #973.)

**Acceptance** every assumption in the plan maps to an ADR row; no row states a Koch fact without a
source. Docs-only classifier passes.

---

# Part B — Terraform (issues #974–#977)

Layout (all under `infra/terraform/`):

```
versions.tf.tmpl                 # copied into each stack by a tiny script or kept identical by test
modules/
  network/  data/  edge/  ecs-service/  agentcore/  observability/  ci-identity/
stacks/
  00-foundation/  10-network/  20-data/  30-platform/  35-deploy-tasks/
  40-services/    50-agentcore/  60-observability/
envs/
  personal-stage/  personal-prod/  personal-rehearsal/
    backend.hcl            # bucket, region, kms key; key is passed per stack on the command line
    env.tfvars             # everything environment-specific
    release.auto.tfvars    # image digests only; the one file a deploy changes
policy/                    # conftest .rego rules + fixtures
README.md
```

Every stack is invoked the same way (the pipeline and humans use one wrapper, `infra/terraform/tf.sh`):

```bash
infra/terraform/tf.sh <env> <stack> <plan|apply|destroy|output> [extra args]
# expands to: terraform -chdir=stacks/<stack> init -backend-config=../../envs/<env>/backend.hcl \
#   -backend-config="key=<env>/<stack>.tfstate" && terraform <cmd> \
#   -var-file=../../envs/<env>/env.tfvars -var-file=../../envs/<env>/release.auto.tfvars
```

**Stack order and what each publishes to SSM** (`/comparative/<env>/<stack>/<key>`):

| Stack | Creates | Publishes |
|---|---|---|
| `00-foundation` | KMS keys, ECR repos, CI roles (one per account: applied from the first env in that account, guarded by `var.manage_account_singletons`) | `kms/data_arn`, `kms/logs_arn`, `kms/secrets_arn`, `ecr/app_repo_url`, `ecr/agent_repo_url` |
| `10-network` | VPC or adoption of one, subnets, endpoints, security groups, optional stand-in proxy | `vpc_id`, `app_subnet_ids`, `data_subnet_ids`, `public_subnet_ids`, `agentcore_subnet_ids`, `sg/{alb,web,worker,browser_proxy,studio_browser,deploy_task,db,agent_runtime}_id`, `proxy_url`, `no_proxy` |
| `20-data` | RDS, optional RDS Proxy, secret shells, buckets | `db/endpoint`, `db/port`, `db/instance_id`, `secret/app_arn`, `secret/browser_proxy_arn`, `secret/browser_proxy_db_arn`, `bucket/alb_logs`, `bucket/artifacts` |
| `30-platform` | ECS cluster, service-discovery namespace, ALB, listeners, target group, optional DNS and WAF association | `cluster_arn`, `cluster_name`, `namespace_id`, `alb_arn`, `alb_dns_name`, `alb_arn_suffix`, `tg/web_arn`, `tg/web_arn_suffix`, `base_url` |
| `35-deploy-tasks` | Migrator and smoke task definitions and their roles and log groups | `taskdef/migrator_arn`, `taskdef/smoke_arn` |
| `50-agentcore` | Runtime, endpoint, Studio Browser, credential provider, runtime role | `runtime_arn`, `browser_id`, `browser_arn` |
| `40-services` | Four ECS services, task definitions, task/execution roles, autoscaling | `service/{web,chat_worker,memory_worker,browser_proxy}_name` |
| `60-observability` | Log metric filters, alarms, SNS topic and subscriptions, dashboard | `sns/ops_topic_arn` |

Apply order for a new environment: 00 → 10 → 20 → 30 → 35 → 50 → 40 → 60. A routine deploy touches
35, 50 and 40 only.

## WP-08 — Terraform foundation, wrapper, policy checks

**Issue** #974 · **Model** Sonnet · **Depends on** nothing

**Create**
- `infra/terraform/README.md`, `tf.sh`, `.gitignore` (`.terraform/`, `*.tfplan`, `*.tfstate*`), a shared
  `versions.tf` per stack (identical; a test asserts they are byte-equal), `providers.tf` with
  `default_tags` from `var.tags`, `variables.tf` with the common inputs: `env`, `name_prefix`,
  `aws_region`, `tags`, `account_id` (validated against `data.aws_caller_identity`).
- `modules/ci-identity`: `aws_iam_openid_connect_provider` for `token.actions.githubusercontent.com`
  (created only when `var.create_oidc_provider`; the personal account already has one owned by
  `AiWorkspaceEvalCiStack`, so the default there is `false` with a data lookup until WP-20). Roles:
  - `${name_prefix}-tf-plan`: trust = this repository, any ref, `aud = sts.amazonaws.com`; permissions =
    `ReadOnlyAccess` plus read of the state bucket and `kms:Decrypt` on the state key. No secret values:
    explicit deny on `secretsmanager:GetSecretValue`.
  - `${name_prefix}-tf-apply`: trust = `repo:<owner>/<repo>:environment:<env>` only (GitHub environment
    subject), so it cannot be assumed from a pull-request ref. Permissions = the services the stacks
    manage (ECS, ELB, EC2 networking, RDS, IAM limited to roles/policies under path `/comparative/<env>/`
    with a permissions boundary, Secrets Manager metadata only, KMS, Logs, CloudWatch, SNS, SSM
    parameters under `/comparative/<env>/`, ECR, Bedrock AgentCore control plane, Route 53/ACM/WAF when
    used) plus `ecs:RunTask` for the deploy tasks.
  - `${name_prefix}-image-push`: trust = `repo:<owner>/<repo>:ref:refs/heads/main`; ECR push to the two
    repos, `kms:Sign` on the signing key.
  - `${name_prefix}-evals`: the Bedrock-invoke-only role that replaces `ComparativeGitHubEvalsRole`
    (same trust conditions as `infra/cdk/lib/ai-workspace-eval-ci-stack.ts:69-117`, model ARNs from
    `var.eval_model_ids`).
  Repository identity (`owner`, `repo`, numeric ids) is a variable.
- `stacks/00-foundation`: three KMS keys with rotation (data, logs, secrets) and one asymmetric signing
  key (`ECC_NIST_P256`, `SIGN_VERIFY`) for images; ECR repos `${name_prefix}-app` and
  `${name_prefix}-agent` with `image_tag_mutability = "IMMUTABLE"`, scan on push, KMS encryption, and a
  lifecycle policy (keep the last 60 release-tagged images, expire untagged after 7 days); the
  `ci-identity` module; SSM outputs.
- `policy/*.rego` (Conftest on `terraform show -json` output) with a passing and a failing fixture each:
  no `assign_public_ip = true` on ECS services; no security-group ingress from `0.0.0.0/0` except on an
  ALB security group when `internal_alb = false`; RDS, S3, log groups, secrets, ECR encrypted; required
  tags present; no IAM statement with `bedrock:*` or `Resource: "*"` for `bedrock:InvokeModel*`; S3
  buckets block public access; no IAM user or access key resources.
- `.github/workflows/terraform-ci.yml`: on PRs touching `infra/terraform/**` — `fmt -check`,
  `validate` for every stack (with `-backend=false`), `tflint`, a config scan (Trivy config or Checkov;
  pick one already available as an action pinned by SHA), `conftest` against the fixtures, and
  `terraform test` for modules. No cloud credentials in this workflow. Add it as a non-required check
  first; Rob makes it required.
- `envs/personal-stage/{backend.hcl,env.tfvars,release.auto.tfvars}` with placeholders clearly marked.

**Acceptance** `terraform-ci` green on the PR; the failing fixtures fail for the stated reason;
`./tf.sh personal-stage 00-foundation plan` is the documented first command.

**Rob runs** (document exactly in the PR): create the state bucket and its KMS key (a 10-line bootstrap
`infra/terraform/bootstrap/` config applied once with local state, then state migrated into the bucket),
then `./tf.sh personal-stage 00-foundation apply`. `needs-rob` (IAM, KMS).

## WP-09 — Network stack

**Issue** #975 · **Model** Opus · **Depends on** WP-08

**Why.** Today: the default VPC (`172.31.0.0/16`), six public subnets, a public IP on every task, no NAT,
no endpoints (`infra/cdk/lib/ai-workspace-ecs-stack.ts:172-174, 216-228, 541-545`).

**`modules/network` inputs**

| Variable | Type | Meaning |
|---|---|---|
| `mode` | `"create" \| "adopt"` | Create a VPC, or use supplied ids (Koch) |
| `vpc_cidr`, `az_count` (default 2) | create mode | /16 by default; subnets /20 |
| `vpc_id`, `app_subnet_ids`, `data_subnet_ids`, `public_subnet_ids` | adopt mode | supplied by the landing zone |
| `firewall_mode` | bool | true = no internet route from app subnets |
| `internal_alb` | bool | true = no public subnets needed |
| `egress` | `"nat" \| "proxy"` | `nat` = one NAT gateway (sandbox). `proxy` = no default route; only `proxy_url` |
| `proxy_url` | string | Koch's proxy. Empty with `egress="proxy"` and `create_standin_proxy=true` builds the stand-in |
| `create_standin_proxy` | bool | personal rehearsal only |
| `proxy_allowlist` | list(string) | hosts for the stand-in proxy (from `pnpm egress:inventory --allowlist`) |
| `interface_endpoints` | list(string) | default: `bedrock-runtime`, `bedrock-agentcore`, `bedrock-agentcore-control`, `secretsmanager`, `kms`, `logs`, `monitoring`, `ecr.api`, `ecr.dkr`, `sts`, `ssm`, `ssmmessages`, `ecs`, `ecs-agent`, `ecs-telemetry`. Created only when `firewall_mode`. Confirm each name with `aws ec2 describe-vpc-endpoint-services` for the region and drop any that do not exist; say which in the PR |
| `agentcore_az_ids` | list(string) | AZ **ids** AgentCore Browser supports (`use1-az1`, `use1-az2`, `use1-az4` in us-east-1 today; `ai-workspace-ecs-stack.ts:51-59` hard-codes names instead) |

**Resources (create mode)** VPC with DNS support; per AZ one app subnet, one data subnet, and (unless
`internal_alb && firewall_mode`) one public subnet; route tables; internet gateway and one NAT gateway
only when `egress = "nat"`; S3 gateway endpoint always; interface endpoints with private DNS and a
dedicated endpoint security group (443 from app security groups) when `firewall_mode`; flow logs to a
KMS-encrypted log group, 30-day retention.

**Security groups (both modes; Terraform owns every rule, no inline rules — use
`aws_vpc_security_group_{ingress,egress}_rule`)**

| Group | Ingress | Egress |
|---|---|---|
| `alb` | 443 (and 80 for redirect) from `var.alb_ingress_cidrs` (the corporate ranges, or `0.0.0.0/0` only when `internal_alb = false`) | 3000 to `web` |
| `web` | 3000 from `alb`; 3000 from `agent_runtime` (MCP facades over the internal URL) | 5432 to `db`; 443 to endpoints; 3128 or proxy port to proxy; when `egress="nat"` 443 to anywhere |
| `worker` | none | same as web, without 3000 rules |
| `browser_proxy` | 3128 from `studio_browser` | 80/443 to anywhere when `egress="nat"`, else to the upstream proxy; 53 to VPC resolver; 5432 to `db` |
| `studio_browser` | none | 3128 to `browser_proxy`; 53 to VPC resolver |
| `agent_runtime` | none | 3000 to `web` via the internal ALB (443 to `alb`); 443 to endpoints; proxy port to proxy |
| `deploy_task` | none | 5432 to `db`; 443 to endpoints / base URL for smoke |
| `db` | 5432 from `web`, `worker`, `browser_proxy`, `deploy_task` | none |

These reproduce the current rules (`ai-workspace-ecs-stack.ts:216-313`) minus the public paths. The DB
group replaces the hand-made `sg-019e87b5938a295a4` and makes `infra/scripts/reconcile-rds-perimeter.sh`
unnecessary.

**Stand-in proxy** (`create_standin_proxy`): a single small Fargate task in a subnet that has NAT, running
a forward proxy with an explicit host allowlist, logging every CONNECT to CloudWatch, reachable only from
the app security groups. Reuse the repository's own egress proxy (`apps/web/lib/browser-egress-proxy.ts`,
run by `pnpm --filter @ai-workspace/web browser:egress-proxy`) if it can take a static allowlist from an
environment variable; otherwise a pinned public squid image. Its only purpose is to imitate Koch's proxy.

**`NO_PROXY` output** = endpoint DNS names + internal ALB host + `169.254.170.2,localhost,127.0.0.1` +
the VPC resolver.

**Tests** (`terraform test`, plan-only with mock providers): create+nat, create+firewall, adopt. Assert:
no IGW route from app subnets in firewall mode; endpoint list; rule matrix above; AZ-id filtering for
`agentcore_subnet_ids`.

**Acceptance** policy job green; PR body states the monthly cost of each mode (interface endpoints are
about $7.30 per endpoint per AZ per month before data charges: 15 endpoints × 2 AZs ≈ $220/month in
firewall mode; one NAT gateway ≈ $33/month plus data in sandbox mode — recompute with current prices and
cite the date).

**Rob runs** `./tf.sh personal-stage 10-network apply`. `needs-rob` (network).

## WP-10 — Data stack

**Issue** #975 · **Model** Sonnet · **Depends on** WP-09

**`modules/data` builds**
- `aws_db_subnet_group` over the data subnets; parameter group for PostgreSQL 16 with `rds.force_ssl=1`
  and `log_min_duration_statement` from a variable.
- `aws_db_instance`: engine `postgres` 16.x (`var.engine_version`, today's is 16.13), `var.instance_class`
  (stage: `db.t4g.micro`), `var.multi_az` (false in personal, true in Koch prod), gp3 storage 20 GB with
  autoscaling to `var.max_allocated_storage`, `storage_encrypted = true` with the data KMS key,
  `publicly_accessible = false`, `backup_retention_period = var.backup_days` (7 personal, 35 Koch prod),
  `deletion_protection = true`, `copy_tags_to_snapshot`, `performance_insights_enabled` (free tier
  retention), `manage_master_user_password = true` (RDS keeps the master secret; it never enters
  Terraform state), `snapshot_identifier = var.restore_snapshot_id` (null for an empty database),
  `final_snapshot_identifier`, `lifecycle { ignore_changes = [snapshot_identifier] }`.
- Optional `aws_db_proxy` + target group behind `var.enable_rds_proxy` (default false; Tier 2).
- Secrets as **shells only**: `comparative/<env>/app`, `comparative/<env>/browser-proxy-db`. Terraform
  creates the secret, KMS key and resource policy; it never writes a version. `comparative/<env>/browser-proxy`
  is generated: `ephemeral "random_password"` + `aws_secretsmanager_secret_version` with
  `secret_string_wo` so the value is not stored in state (JSON `{username:"comparative-browser",password}`
  as today, `ai-workspace-ecs-stack.ts:314-331`).
- Buckets: ALB access logs (policy for the regional ELB log-delivery principal, 30-day expiry — replaces
  `infra/scripts/setup-alb-access-logs.sh`) and `artifacts` (KMS, versioned, no public access; unused by
  the app until Tier 3).
- SSM outputs listed in the Part B table.

**Document in `infra/terraform/README.md`** how the application database user and `DATABASE_URL` are
created after the first apply (Rob runs a one-off task with the master secret, creates the app role and
the `web_egress_policy_reader` login role that migration `0050` defines, and writes the two secrets), and
the exact JSON field list of the app secret from §2.

**Tests** plan tests: encryption, not public, deletion protection, proxy off by default, no secret value
in the plan JSON (`grep` the plan for the password field must find nothing).

**Rob runs** `20-data apply`; database user bootstrap; secret values. `needs-rob`.

## WP-11 — Platform, deploy tasks, and services

**Issue** #976 · **Model** Opus · **Depends on** WP-10

**`stacks/30-platform`** — ECS cluster (Container Insights off by default, variable), Cloud Map private
namespace `var.internal_namespace` (today `comparative.internal`), ALB (`internal = var.internal_alb`,
`drop_invalid_header_fields = true`, deletion protection on outside stage, access logs to the bucket),
HTTPS listener with `var.certificate_arn` (or an ACM certificate with DNS validation when
`var.route53_zone_id` is set) and TLS policy `ELBSecurityPolicy-TLS13-1-2-2021-06`, HTTP 301 listener
only when not internal, web target group (HTTP 3000, health `/api/health` 200, 30 s interval, 10 s
timeout, 2/3 thresholds, 30 s deregistration — same as `ai-workspace-ecs-stack.ts:561-572`), optional
Route 53 alias records, optional `aws_wafv2_web_acl_association` with `var.waf_acl_arn`.
`base_url` = `https://${var.domain_name}`.

**`modules/ecs-service`** inputs: `name`, `cluster_arn`, `image` (must be `repo@sha256:…`; a validation
rule rejects tags), `command`, `cpu`, `memory`, `port` (optional), `environment` (map), `secrets`
(map name → `valueFrom`), `subnet_ids`, `security_group_ids`, `desired_count`, `autoscaling`
(`{min,max,cpu_target}` or null), `load_balancer` (`{target_group_arn}` or null),
`service_registry` (`{namespace_id,name}` or null), `task_policy_json`, `execution_secret_arns`,
`min_healthy_percent`, `log_group_name`, `kms_logs_arn`, `health_check` (optional container check),
`cpu_architecture` (default `X86_64`). It creates the log group (30 days, KMS), execution role (ECR pull,
logs, read of the listed secrets and KMS decrypt), task role (the supplied policy), task definition,
service (`assign_public_ip = false`, `deployment_circuit_breaker { enable = true, rollback = true }`,
`wait_for_steady_state = true`, `propagate_tags`, `enable_execute_command = false`,
`lifecycle { ignore_changes = [desired_count] }` when autoscaling is set), and the autoscaling target and
policy. Roles live under IAM path `/comparative/<env>/` with the boundary from `00-foundation`.

**`stacks/35-deploy-tasks`** — two task definitions without services (use the module's task-definition
half or a small sibling module): `migrator` (image digest `var.image_migrator`, default image command,
secret `DATABASE_URL`) and `smoke` (image digest `var.image_worker`, command
`pnpm --filter @ai-workspace/web smoke:prod:auth`, env `SMOKE_BASE_URL` = `INTERNAL_BASE_URL` when set
else the public URL, `SMOKE_RUN_ID` = `var.release_id`, secrets `DATABASE_URL`, `NEXTAUTH_SECRET`). Same
as `infra/cdk/lib/ai-workspace-deploy-tasks-stack.ts:85-145`.

**`stacks/40-services`** — four module calls. Values that must match production today:

| Service | Image var | Command | CPU/Mem | Count | Port / LB | Extra env (beyond common) | Task-role permissions |
|---|---|---|---|---|---|---|---|
| `web` | `image_web` | image default (`node apps/web/server.js`) | 512/1024 | autoscale `var.web_min`..`var.web_max` at 60 % CPU, cooldowns 60 s out / 300 s in (prod today: 2..4; PR #963 proposes min 1 for the sandbox) | 3000, target group | `CHAT_RUN_IN_PROCESS_WORKER=0`, `MEMORY_CAPTURE_IN_PROCESS_SCHEDULER=0`, `INVITE_EMAIL_PROVIDER`, `INVITE_EMAIL_FROM`, `INVITE_EMAIL_AWS_REGION`, `AGENTCORE_BROWSER_ENABLED`, `AGENTCORE_BROWSER_ID`, `AGENTCORE_BROWSER_PROXY_HOST=browser-proxy.<namespace>`, `AGENTCORE_BROWSER_PROXY_PORT=3128`, `AGENTCORE_BROWSER_PROXY_SECRET_ARN`, `STUDIO_SANDBOX_DNS_SUFFIX=.<namespace>` | Bedrock invoke on `var.bedrock_model_arns`; `ses:SendEmail` on the one identity; AgentCore Browser `StartBrowserSession`, `GetBrowserSession`, `StopBrowserSession`, `InvokeBrowser`, `ConnectBrowserLiveViewStream` on the browser ARN; `InvokeAgentRuntime`, `InvokeAgentRuntimeForUser` on the runtime ARN and `…/*`; read of the browser-proxy secret |
| `chat-worker` | `image_worker` | `pnpm --filter @ai-workspace/web worker:chat-runs` | 256/512 | `var.chat_worker_count` (1), min healthy 0 % | none | `RUNTIME=agentcore`, `AGENTCORE_RUNTIME_ARN` (from SSM), `MEMORY_CAPTURE_IN_PROCESS_SCHEDULER=0` | Bedrock invoke; `InvokeAgentRuntime*` |
| `memory-worker` | `image_memory_worker` | `pnpm --filter @ai-workspace/web worker:memory-capture` | 256/512 | 1, min healthy 0 % | none | `MEMORY_CAPTURE_IN_PROCESS_SCHEDULER=0` | Bedrock invoke |
| `browser-proxy` | `image_worker` | `pnpm --filter @ai-workspace/web browser:egress-proxy` | 256/512 | 1 | 3128, Cloud Map name `browser-proxy`, TCP container health check | `BROWSER_PROXY_PORT=3128` only (not the common set) | none |

Common environment for web and both workers (`ai-workspace-ecs-stack.ts:333-348`) plus the §2 contract:
`NODE_ENV=production`, `AWS_REGION`, `BEDROCK_CLIENT=real`, `RUNTIME=bedrock`, `RUNTIME_V2_ENABLED=1`,
`RUNTIME_V2_DIRECT_MODEL_ID=auto`, `NEXTAUTH_URL`, `INTERNAL_BASE_URL` (when set),
`LEGACY_HOST_REDIRECT_FROM`, `HOSTNAME=0.0.0.0`, `PORT=3000`, `BEDROCK_INFERENCE_PROFILE_PREFIX`,
proxy variables from SSM (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, and `NODE_USE_ENV_PROXY=1` if WP-03
chose that route), and `var.extra_environment` (a map in `env.tfvars` for the switches in §2).
Secrets: the fifteen fields at `ai-workspace-ecs-stack.ts:18-34` for web and workers,
`GITHUB_WEBHOOK_SECRET` for web only, optional fields listed in `var.optional_app_secret_fields`; the
browser proxy gets `DATABASE_URL` from the browser-proxy-db secret and `BROWSER_PROXY_USERNAME`/
`BROWSER_PROXY_PASSWORD` from the generated one.

`var.bedrock_model_arns` is built from `var.bedrock_model_ids` × the profile prefix × the regions the
profile routes to (inference-profile ARN in the home region plus foundation-model ARNs in each routed
region), the same shape as `infra/cdk/lib/ai-workspace-eval-ci-stack.ts:23-39, 100-117`. No `*`.

`release.auto.tfvars` holds exactly: `release_id`, `image_web`, `image_worker`, `image_memory_worker`,
`image_migrator`, `image_agent`.

**Tests** module tests for `ecs-service` (digest validation, no public IP, circuit breaker, autoscaling
ignore). A stack-level plan test that changing only `release.auto.tfvars` yields changes confined to
`aws_ecs_task_definition` and `aws_ecs_service` resources. Port the invariants from
`apps/web/__tests__/ecs-cdk-browser.test.ts` and `ecs-deploy-task-stack.test.ts` (read them; each
`expect` is a requirement) into `terraform test` assertions or Conftest rules; list each ported invariant
in the PR body.

**Rob runs** applies for 30, 35, 40 in stage. `needs-rob` (IAM, secrets wiring).

## WP-12 — Observability stack

**Issue** #976 · **Model** Sonnet · **Depends on** WP-11

Recreate every alarm that exists today, from both sources, parameterised by environment:

| Alarm | Source today | Definition |
|---|---|---|
| web below task floor | CDK `:817-837` | `AWS/ECS` running task count < `var.web_min` for 3 of 3 one-minute periods; missing data breaching |
| web unhealthy hosts | CDK `:789-809` | target group `UnHealthyHostCount` max ≥ 1 for 3 of 3 minutes |
| browser proxy unavailable | CDK `:679-704` | running task count < 1 for 3 of 3 minutes; missing data breaching; alarm and OK actions |
| memory capture failures | CDK `:643-677` | log metric filter on the memory-worker group for `memory-capture-error` or `memory-capture-worker-fatal`; sum ≥ 1 in 20 minutes |
| Bedrock token headroom | CDK `:60-65, 706-753` | math over `AWS/Bedrock` input + 5 × output tokens per day **for each id in `var.quota_alarm_models`** (`{model_id, daily_quota, output_burndown}`), threshold 80 %. Today's alarm watches only Sonnet 4.5 while chat defaults to Sonnet 4.6: default the list to both |
| chat worker no running tasks, memory worker no running tasks | `infra/scripts/setup-ops-alarms.sh:52-125` | running task count < 1 |
| web 5xx, load balancer 5xx | same script | read the script for exact metric, period and threshold and reproduce them |
| run failure burst | same script | metric filter `run-failed-events` on the chat-worker log group, namespace and threshold as in the script |
| **new:** queue depth | none today | not in this WP — it needs an application metric (Tier 2, #449). Leave a commented variable, no resource |

Plus: SNS topic `${name_prefix}-ops-alerts` (KMS), email subscriptions from `var.alert_emails`
(confirmation is manual), every alarm with alarm and OK actions to the topic, a CloudWatch dashboard with
the same metrics. Port `apps/web/__tests__/ecs-cdk-alarms.test.ts` and `ops-alarms-script.test.ts`
invariants as plan tests.

**Rob runs** `60-observability apply`; confirms the email subscription.

## WP-13 — AgentCore stack

**Issue** #977 · **Model** Opus · **Depends on** WP-01, WP-11

**Why.** The runtime is `PUBLIC` network mode, updated by raw CloudFormation with a sequence parameter
(`infra/scripts/update-agentcore-stack.sh`), its ARN is hard-coded in the ECS stack (`:618-619`), and its
invoke policy is attached to task roles by generated name (`ai-workspace-agentcore-spike-stack.ts:334-341`).

**Step 1 — spike, written up in the PR before any module code.** In a scratch environment, answer with
evidence (plan output, a successful invocation, or the exact error):
1. Does `aws_bedrockagentcore_agent_runtime` with `network_configuration { network_mode = "VPC"
   network_mode_config { subnets, security_groups } }` create and reach READY with our arm64 container?
2. Can the runtime in VPC mode reach Bedrock, the AgentCore data plane, ECR and CloudWatch Logs through
   interface endpoints only, and the app's MCP facades through the internal ALB?
3. Does a container-digest change update in place and produce a new runtime version, and does
   `aws_bedrockagentcore_agent_runtime_endpoint` follow it?
4. Does `aws_bedrockagentcore_browser` with `network_mode = "VPC"` and `vpc_config` work in the AZ ids
   from WP-09, with `browser_signing` enabled as today (`ai-workspace-ecs-stack.ts:467-486`)?
5. Does `aws_bedrockagentcore_api_key_credential_provider` with `api_key_secret_config { secret_id, json_key }`
   reproduce the current external-secret source for Brave (`spike-stack.ts:92-110`)?
6. What does the runtime's outbound proxy story look like in VPC mode (environment variables on the
   container, honoured by WP-03's bootstrap)?
If any answer is no, try the `awscc` provider for that resource. If still no, stop and report: the
fallback is to run the durable lane on direct Bedrock from the chat-worker (`RUNTIME=bedrock`) for the
Koch build, which Rob must decide.

**Step 2 — `modules/agentcore` and `stacks/50-agentcore`**
- Runtime role: trust `bedrock-agentcore.amazonaws.com`; ECR pull on the agent repo; Bedrock invoke on
  `var.bedrock_model_arns`; `bedrock-agentcore:GetResourceApiKey` on the workload identity, token vault
  and the credential provider (only when web search is on); logs under `/aws/bedrock-agentcore/*`;
  VPC network-interface permissions if the spike shows they are needed. Drop the
  `aws-marketplace:Subscribe` grant unless the spike shows the runtime needs it.
- Runtime: `agent_runtime_name = replace("${name_prefix}_agent", "-", "_")`, container
  `var.image_agent` (digest), `network_mode` from `var.agentcore_network_mode` (`PUBLIC` in sandbox,
  `VPC` in firewall mode), `protocol_configuration { server_protocol = "HTTP" }`, environment:
  `BEDROCK_CLIENT=real`, `AWS_DEFAULT_REGION`, `WEB_SEARCH_PROVIDER`, `BRAVE_SEARCH_CREDENTIAL_PROVIDER`
  (when on), `BEDROCK_INFERENCE_PROFILE_PREFIX`, proxy variables.
- Endpoint resource if the application addresses a qualifier (`AGENTCORE_QUALIFIER` is read by the app;
  check how).
- Studio Browser with the two modes, execution role able to read the browser-proxy secret.
- Publish `runtime_arn`, `browser_id`, `browser_arn` to SSM. `40-services` reads them; the invoke
  permissions in WP-11 reference the ARN, not a role name.

**Tests** plan tests for both network modes; a rule that the runtime role has no `Resource: "*"` for
Bedrock.

**Acceptance** in `personal-stage` (sandbox mode) a durable run completes on the Terraform-managed
runtime. In a scratch firewall-mode environment the spike questions are answered with evidence.

**Rob runs** every apply in this WP, including the scratch environment. `needs-rob`.

---

# Part C — GitOps pipeline (issues #978, #979)

Target flow:

```
PR merged to main ─► build-release.yml ─► 5 images by digest, SBOM, scan, signature
                                      └─► release PR: envs/personal-stage/release.auto.tfvars
release PR merged ─► terraform-apply.yml (environment: personal-stage)
                       35-deploy-tasks apply ─► migrator task ─► 50-agentcore apply
                       ─► 40-services apply (steady state) ─► smoke task ─► GitHub deployment record
promote.yml (manual) ─► PR copying stage digests into envs/personal-prod/release.auto.tfvars
                       ─► same apply workflow, environment: personal-prod (required reviewer)
terraform-drift.yml (nightly) ─► plan -detailed-exitcode per env × stack ─► issue on drift
```

Until WP-20, this pipeline deploys **only** `personal-stage`. Production stays on CodeBuild.

## WP-14 — Build once: images by digest, SBOM, scan, signature, release pull request

**Issue** #978 · **Model** Opus · **Depends on** WP-08

**Today.** `buildspec.yml:64-111` builds four targets from `apps/web/Dockerfile` (default `runtime`,
`migrator`, `worker`, `memory-worker`) on x86 and starts a child ARM build for
`apps/agentcore-agent/Dockerfile`; it pushes `latest` and SHA tags to a mutable registry and deploys in
the same job.

**Create `.github/workflows/build-release.yml`**
- Trigger: `push` to `main`. First job reuses the PR classifier
  (`.github/workflows/classify-changed-paths.yml`): docs-only → stop.
- Permissions: `id-token: write`, `contents: read`. Assume `${name_prefix}-image-push` (WP-08) by OIDC.
- Build matrix with `docker/build-push-action` and BuildKit GitHub cache, all actions pinned by commit SHA
  like the existing workflows:
  `web` (target `runtime`, amd64), `worker` (amd64), `memory-worker` (amd64), `migrator` (amd64) → repo
  `${name_prefix}-app`; `agent` (arm64, on an arm64 runner or QEMU) → repo `${name_prefix}-agent`.
  Tag scheme (immutable repos): `<component>-<full sha>`. Never `latest`.
- Build args `NODE_VERSION` and a new `BASE_IMAGE_REGISTRY` (default `public.ecr.aws/docker/library`) so a
  mirror can replace the public registry; pin the base image by digest in both Dockerfiles.
  `PNPM_REGISTRY` build arg wired to `pnpm config set registry` when set.
- Per image: SBOM (SPDX JSON, attached as an OCI referrer and uploaded as an artifact), vulnerability
  scan failing on fixable critical/high (configurable allowlist file with expiry dates), cosign signature
  with the KMS key from `00-foundation` (`cosign sign --key awskms:///<arn> <repo>@<digest>`).
- Final job writes `release.json` (`release_id` = full SHA, the five `repo@sha256:` references, SBOM and
  scan artifact names) and opens or updates a pull request on branch `release/personal-stage` that
  replaces `infra/terraform/envs/personal-stage/release.auto.tfvars`. Title
  `release(personal-stage): <short sha>`; body lists the commits since the previous release id and links
  the scan results.
- Idempotent: re-running on the same SHA finds the existing tags and reuses their digests.

**The release-PR gate (Rob-owned design decision — implement the proposal, flag it).** A pull request
opened with the default `GITHUB_TOKEN` does not trigger other workflows, and the repo requires CI and
`Claude verdict` on every PR. Proposal: a "release lane" in `claude-verdict.yml` and the CI summary jobs
that reports success **only if** the diff is exactly one `envs/*/release.auto.tfvars` file and every
digest in it has a valid signature from the signing key and a `release.json` produced by a
`build-release` run on a commit that is on `main`. Anything else in the diff falls back to the normal
lane. This changes the merge gate (#900): put it in its own commit, describe it at the top of the PR, and
expect Rob to review that part line by line. The bot identity is a GitHub App Rob creates; until it
exists, the workflow uploads `release.auto.tfvars` as an artifact and a human opens the PR.

**Tests** unit-test the release-lane verifier script with fixtures: valid; extra file in diff; unsigned
digest; digest signed but from a non-main commit; tfvars with a tag instead of a digest.

**Acceptance** a merge to `main` produces five signed digests and a release PR whose only change is the
tfvars file; no long-lived credentials exist in the repository settings.

**Rob runs** GitHub App creation and secrets; makes the push role's trust live; reviews the gate change.
`needs-rob`.

## WP-15 — Plan on pull request, apply on merge, promotion

**Issue** #979 · **Model** Opus · **Depends on** WP-14, WP-11

**Create `.github/workflows/terraform-plan.yml`** — on PRs touching `infra/terraform/**`:
compute the affected (env, stack) pairs (a change under `modules/` or `stacks/<s>` affects every env; a
change under `envs/<e>/` affects that env; `release.auto.tfvars` affects stacks 35, 50, 40 only); for each
pair assume `${name_prefix}-tf-plan`, run `tf.sh <env> <stack> plan -out`, convert with
`terraform show -json`, run Conftest, upload the plan as an artifact keyed by head SHA, and post one
sticky PR comment per environment with a resource-level summary (adds/changes/destroys by type; never
values). A plan that would destroy or replace a stateful resource (`aws_db_instance`, `aws_kms_key`,
`aws_s3_bucket`, `aws_secretsmanager_secret`, `aws_ecr_repository`) fails the job unless the PR carries
the label `allow-stateful-replace` (only Rob applies it).

**Create `.github/workflows/terraform-apply.yml`** — on push to `main` for the same paths, one job per
affected env, `environment: <env>` (this is what the apply role's trust checks),
`concurrency: tf-apply-<env>` with `cancel-in-progress: false`. Steps for a release change:
1. Verify signatures of every digest in `release.auto.tfvars` (`cosign verify --key awskms://…`). Fail closed.
2. Apply `35-deploy-tasks`.
3. If `packages/db/drizzle/**` changed since the environment's previous `release_id`: take an RDS snapshot
   named `pre-migrate-<sha12>-<run>` and wait (logic from `infra/scripts/snapshot-rds-before-migrate.sh`,
   reading the instance id from SSM); prune snapshots with that prefix older than `var.snapshot_keep_days`.
4. Run the migrator task and require exit code 0 (new script `infra/terraform/scripts/run-task.sh <env>
   <migrator|smoke>`; port `infra/scripts/run-ecs-deploy-task.sh:16-118` but read cluster, subnets,
   security group and task-definition ARN from SSM parameters; private subnets, no public IP).
5. Apply `50-agentcore`, then `40-services` (Terraform waits for steady state; the circuit breaker rolls
   back a bad task set and the apply fails).
6. Run the smoke task. On failure: open a revert PR for the release commit and fail the job. Do not
   auto-merge it.
7. Record a GitHub Deployment for the environment with the release id, digests, plan hashes, snapshot id,
   migrator and smoke task ARNs and exit codes; mark it success or failure. Also print the same JSON as
   the job summary. (This replaces the receipt lines in the CodeBuild log.)
For non-release infrastructure changes: apply the affected stacks in the Part B order, re-plan first and
fail if the plan differs from the artifact reviewed on the merged PR's head SHA.

**Create `.github/workflows/promote.yml`** — `workflow_dispatch` with `from` and `to` environments. Checks
that the `from` environment's latest deployment for its current `release_id` is successful, then opens a
PR copying `release.auto.tfvars`. For a `to` environment marked `production = true` in its `env.tfvars`,
also require a green `pnpm eval --gate` run on that release id (dispatch `product-smoke.yml` with
`run_evals=true` against the `from` environment's base URL and wait).

**Create `.github/CODEOWNERS`** entries: `infra/terraform/envs/*-prod/` and `infra/terraform/modules/ci-identity/`
owned by Rob.

**Tests** unit tests for the affected-pairs script and the stateful-replace detector (fixtures of plan
JSON); `run-task.sh` tested the way `apps/web/__tests__/ecs-deploy-task-script.test.ts` tests its
predecessor (stubbed `aws`).

**Acceptance** in `personal-stage`: merging a release PR deploys with no manual step and leaves a
successful Deployment; reverting it restores the previous digests; a PR that edits a module shows a plan
comment; the apply role cannot be assumed from a `pull_request` run (prove it with a deliberately failing
job in the PR and paste the denial).

**Rob runs** GitHub environments and protection rules (`personal-stage` no reviewers; `personal-prod`
required reviewer Rob), the role trust going live. `needs-rob`.

## WP-16 — Drift detection, break-glass, deployment docs

**Issue** #979 · **Model** Sonnet · **Depends on** WP-15

- `.github/workflows/terraform-drift.yml`: nightly and on dispatch; for each env × stack run
  `plan -detailed-exitcode -lock=false` with the plan role; exit code 2 opens or refreshes one issue per
  environment labelled `ops` with the resource-level summary; exit code 0 closes it.
- Break-glass: `${name_prefix}-break-glass` role in `ci-identity` (trust = named IAM principals from a
  variable, MFA required), an EventBridge rule on `AssumeRole` for it that notifies the ops topic, and
  `docs/runbooks/BREAK_GLASS.md`: when it may be used, how, and the rule that every change is reconciled
  into Git within one working day (the drift job enforces it).
- Rewrite `docs/PRODUCTION_DEPLOYMENT.md` for the new flow, keeping the old flow in a clearly marked
  "CDK (until cutover)" section that WP-20 deletes. Add `docs/runbooks/ROLLBACK.md` (revert the release
  PR; database changes are expand-only so no schema rollback; AgentCore follows the same revert).
- Update `docs/runbooks/README.md` index.

**Acceptance** a manual console edit to a stage security group produces a drift issue on the next run and
closes after the edit is reverted (Rob performs the edit; paste the two issue events in the PR).

---

# Part D — Identity (issues #982, #983)

## WP-17 — Ping OIDC with group claims; restricted magic links

**Issue** #982 · **Model** Opus · **Depends on** WP-01

**Today** (`apps/web/lib/auth/nextauth.ts`): NextAuth v4, JWT sessions; `KNOWN_AUTH_PROVIDERS =
["github","email"]` (`:60`); `AUTH_PROVIDERS` allowlist (`:64-87`); GitHub provider with
`allowDangerousEmailAccountLinking: true` (`:189-201`); hand-rolled email provider (`:136-155`); invite
gate `emailAllowedToSignIn` (`:160-183`); sign-in decision (`:233-305`); session ages (`:212-219`,
`:314-318`); callbacks `signIn` (`:332`, `:361`), `jwt` (`:388`), `session` (`:447`).
`users.ping_subject` is the unique external identity (`packages/db/src/schema.ts:160, 211-213`): a GitHub
user's value is the bare GitHub account id; a magic-link user's is `email:<address>`. First signer
becomes admin (`apps/web/lib/users.ts:82-88`).

**Build**
1. Provider id `pingone` in `KNOWN_AUTH_PROVIDERS`: a NextAuth OAuth provider of `type: "oauth"` with
   `wellKnown: ${OIDC_ISSUER}/.well-known/openid-configuration`, `idToken: true`,
   `checks: ["pkce","state","nonce"]`, `authorization.params.scope = OIDC_SCOPES ?? "openid profile email"`,
   client id/secret from env, `profile()` returning `{ id: "pingone:" + sub, email, name }`. The display
   name on the sign-in page comes from `OIDC_DISPLAY_NAME` (default "Single sign-on"). Any OIDC IdP works;
   the id is historical.
2. Identity rules in the sign-in decision:
   - Match on `ping_subject = "pingone:<sub>"` first.
   - Never link by email alone. One exception, off by default: when `OIDC_ADOPT_EMAIL_USERS=1`, the ID
     token has `email_verified === true`, and exactly one user exists with
     `ping_subject = "email:<same address, lower-cased>"`, rewrite that row's subject to the OIDC subject
     and write an audit row `auth.identity_adopted`. This is how pilot users move from magic link to Ping
     without losing their data.
   - Access gate when `pingone` is enabled: if `OIDC_REQUIRED_GROUP` is set the groups claim must contain
     it; invitations are not consulted for OIDC sign-ins. Refusals render the existing "not allowed" page
     with a reason code and write `auth.signin_denied`.
3. Roles and groups: read `OIDC_GROUPS_CLAIM` (default `groups`, array of strings) from the ID token (and
   userinfo if absent). `role = admin` iff the claim contains `OIDC_ADMIN_GROUP`; re-evaluated on every
   sign-in (a user removed from the group loses admin at next sign-in). When any OIDC provider is enabled,
   first-signer-becomes-admin is disabled (`lib/users.ts:82-88`). Persist the group names:
   the next free migration number at the time (`0053` is taken by WP-02, `0054` possibly by WP-06) — table `user_groups(user_id uuid references users on delete cascade,
   group_name text not null, source text not null default 'oidc', synced_at timestamptz not null default now(),
   primary key (user_id, group_name))` plus index on `group_name`; replace the user's rows on each
   sign-in in one transaction. Nothing reads this table yet except an admin user-detail view (add the
   list there). It is the seed of the #491 group substrate.
4. Magic link restrictions: `MAGIC_LINK_ALLOWED_DOMAINS` (comma list; when set, other domains get the
   generic "check your email" response and no email is sent — do not reveal the rule) and
   `MAGIC_LINK_SUNSET` (ISO date; after it the email provider is not registered and the sign-in page
   hides the form). Audit action `auth.magic_link_requested` already exists or is added alongside the
   current auth audit events (`nextauth.ts:332-374`).
5. Remove `allowDangerousEmailAccountLinking` from the GitHub provider. Check what relied on it (the
   comment at `:39` and `:196` explains the magic-link/GitHub overlap) and keep existing GitHub users
   working by subject match; a GitHub sign-in whose email matches an `email:` user is now refused with a
   clear message. Put this behaviour change at the top of the PR.
6. Add an index migration: `CREATE INDEX users_email_lower_idx ON users (lower(email))` (the invite gate
   queries `lower(email)`, `nextauth.ts:172`, with no index). Same migration file as the table is fine.
7. `SESSION_MAX_AGE_SECONDS` / `SESSION_UPDATE_AGE_SECONDS` replace the constants at `:212-219`.

**Tests**
- A local OIDC mock issuer for unit/integration tests (discovery document, JWKS, token endpoint signing
  ID tokens with configurable claims). No network.
- Cases: happy path creates a `pingone:` user; admin group → admin, removed → user on next sign-in;
  required group missing → denied + audit row; same email different `sub` → two users, never merged;
  adoption flag on/off, `email_verified` false; first-signer rule off under OIDC; magic link domain
  allowlist and sunset; GitHub sign-in unaffected when `AUTH_PROVIDERS=github,email` except the removed
  linking; group rows replaced transactionally.
- Playwright: sign-in page shows the SSO button when enabled, and no magic-link form after sunset.

**Acceptance** gate green; with `AUTH_PROVIDERS` unset, existing tests pass unchanged except those that
asserted email-based linking.

**Rob runs** the migration ships with deploy; Ping app registration and the env/secret values for any
environment that turns it on. `needs-rob` (auth surface, migration, permissions).

## WP-18 — User status, session revocation, admins scoped like everyone else

**Issue** #983 · **Model** Opus · **Depends on** WP-17

**Today.** No status column; deleting a user cascades their threads and runs
(`packages/db/src/schema.ts:255-257, 636-638`). JWT sessions cannot be revoked (`nextauth.ts:212-217`).
`getSessionUser()` runs `UPDATE users SET last_seen_at` on every call
(`apps/web/lib/auth/getSessionUser.ts:20-38`). `userScope()` returns no filter for admins
(`apps/web/lib/auth/scope.ts:16-21`); callers: `app/api/chat/route.ts`, `app/api/threads/route.ts`,
`app/api/threads/[id]/route.ts`, `…/messages/route.ts`, `…/export/route.ts`, `app/api/feedback/route.ts`,
`app/api/runs/[id]/status/route.ts`, `lib/notifications.ts`.

**Build**
1. Migration: `users.status text not null default 'active'` with a check constraint
   (`active|suspended|deprovisioned`), `users.session_version integer not null default 0`,
   `users.status_changed_at`, `users.status_reason`. Expand-only.
2. Sessions: the `jwt` callback stamps `sv = users.session_version` at sign-in. `getSessionUser()` reads
   the row with a `SELECT` and returns null unless `status = 'active'` and `token.sv === session_version`.
   Update `last_seen_at` only when it is older than 5 minutes (conditional `UPDATE … WHERE last_seen_at <
   now() - interval '5 minutes'`). Check every other place that trusts the JWT without the DB row
   (`apps/web/middleware.ts:18-54` decodes it at the edge — that is acceptable for page gating because
   every API call goes through `getSessionUser`; say so in a comment and a test).
3. `apps/web/lib/user-lifecycle.ts`: `suspendUser(id, actor, reason)`, `reactivateUser`,
   `deprovisionUser`. Suspend/deprovision in one transaction: set status, bump `session_version`, mark
   the user's OAuth token rows revoked (the existing `oauth_tokens.revoked_at` path; provider-side
   revocation stays #692), disable their schedules and event triggers (existing enabled flags), cancel
   queued runs through the existing cancel path (`lib/run-actions.ts`), and write audit rows. Reactivate
   restores sign-in only; schedules stay off until the user re-enables them. Nothing is deleted.
   Admin UI: status column and actions in `app/admin/UsersTable.tsx` with a confirmation naming the
   effects; API route under `app/api/admin/users/`. An admin cannot suspend themself or the last admin.
   The chat worker and scheduler must skip runs whose owner is not active (add the check where runs are
   claimed and where schedules enqueue; cite the lines you changed).
4. Admin scope: `userScope()` returns `eq(column, user.id)` for every role. Go through each caller listed
   above and each admin page; where an admin feature genuinely needs another user's data, it must use an
   explicit admin route that (a) calls `requireAdmin`, (b) takes a `reason` (non-empty, ≤ 500 chars), and
   (c) writes an `admin.user_data_access` audit row with the target user and resource before returning
   data. `app/api/admin/runs/[id]/trace/route.ts` already returns redacted traces; add the reason and the
   audit row there. Do not build a general impersonation feature.
5. Extend the scoping integration tests (`pnpm --filter @ai-workspace/web test:integration`): for each of
   the eight callers, an admin requesting another user's resource gets the same 404/empty result a normal
   user gets.

**Tests** unit tests for lifecycle functions with a fake clock; integration tests above; a test that a
suspended user's request with a still-valid JWT is refused; a test that `last_seen_at` is written at most
once per window.

**Acceptance** gate green; PR body lists every admin surface examined and what changed for each.

**Rob runs** migration with deploy. `needs-rob` (permissions behaviour change, migration). Tell Rob in the
PR which admin habits this breaks (reading another user's thread from the normal UI).

---

# Part E — Rehearsal and cutover (issues #981, #980)

## WP-19 — Firewall rehearsal environment and harness

**Issue** #981 · **Model** Sonnet · **Depends on** WP-03, 04, 05, 09–13, 15 (WP-06 for the trigger check)

**Build**
- `infra/terraform/envs/personal-rehearsal/env.tfvars`: `firewall_mode = true`, `internal_alb = true`,
  `egress = "proxy"`, `create_standin_proxy = true`, `proxy_allowlist` generated from the egress
  inventory for the Koch switch set (`ENABLED_CONNECTOR_PROVIDERS=salesforce,github`,
  `WEB_SEARCH_PROVIDER=none`, `ANALYTICS_PROVIDER=none`, `GITHUB_EVENT_INGEST_MODE=poll`),
  `agentcore_network_mode = "VPC"`, `INTERNAL_BASE_URL` = the internal ALB URL, single-AZ data,
  smallest sizes, an empty database.
- `infra/terraform/scripts/rehearsal.sh <up|run|report|down>`:
  - `up`: applies all stacks in order.
  - `run`: executes, as in-VPC ECS tasks using the worker image, (1) the authenticated smoke,
    (2) `pnpm eval --gate` against the internal URL with real Bedrock through the endpoint,
    (3) a durable AgentCore run that makes one MCP facade tool call (use the fixture provider the evals
    already have, or Salesforce against a developer org if Rob supplies credentials), (4) one scheduled
    run, (5) one event trigger in poll mode against a stub or a test repository, (6) a magic-link request
    (assert the SES call leaves through the proxy), (7) a Studio Browser session start/stop.
  - `report`: queries VPC flow logs and the stand-in proxy log for the run window and writes
    `docs/security/FIREWALL_REHEARSAL_<date>.md`: pass/fail per check; every destination host seen at the
    proxy; every REJECT in flow logs from app subnets; any direct-to-internet attempt; deviations from
    `EGRESS_INVENTORY.md`.
  - `down`: destroys everything except the state bucket.
- Access for a human to look at the UI: document `aws ssm start-session` port-forwarding through a
  throwaway SSM-managed task (no bastion, no public entry). Optional.

**Acceptance** the script runs end to end in dry-run mode in CI (`--plan-only`: plans every stack and
prints the task commands). The real run is Rob's; its report is committed in a follow-up docs PR and every
failure becomes an issue.

**Rob runs** `rehearsal.sh up|run|report|down`. Estimated cost per rehearsal day: state it in the PR from
the WP-09 numbers.

## WP-20 — Cutover of the personal account and removal of CDK

**Issue** #980 · **Model** Opus · **Depends on** WP-08–16 green in `personal-stage` for at least a week

This WP produces two things: a runbook Rob executes, and one cleanup PR that merges only after the
cutover has held for 7 days.

**A. `docs/runbooks/TERRAFORM_CUTOVER.md`** — numbered, each step with the exact command, the expected
output, and the abort path:
1. Preconditions: stage has taken ≥ 10 pipeline deploys; a restore drill from a production snapshot into
   `personal-rehearsal` (or a scratch env) has succeeded and its row counts match; drift job clean.
2. Create `envs/personal-prod` with the idle-cost profile from PR #963 (web min 1 / max 4, two AZs for
   the ALB, single-AZ database) and `firewall_mode = false`. Apply 00–30, 60. Do not create the database
   yet.
3. Lower DNS TTLs on both records (`comparative.` and `ai-workspace.builtwithrobot.link`) to 60 s a day
   ahead.
4. Maintenance window: scale the CDK services' desired counts to 0 (web last) so nothing writes;
   confirm no running tasks; take the final snapshot of `ai-workspace-db`; apply `20-data` with
   `restore_snapshot_id` set; run the verification queries (row counts for `users`, `chat_threads`,
   `chat_messages`, `runs`, `run_events`, `audit_log`, `workspace_artifacts`; max `created_at` per table)
   against both databases and compare.
5. Populate the new secrets (same field values; `DATABASE_URL` points at the new instance). Create the
   `web_egress_policy_reader` login in the new instance and its secret.
6. Apply 35, run the migrator (expect no pending migrations), apply 50 and 40 with images for **the
   commit production is running**, built and signed by WP-14 (`release_id` = current production SHA).
7. Smoke against the new ALB by `Host` header before DNS moves. Then switch both DNS records (Terraform,
   `30-platform` with the zone id) and smoke again through DNS.
8. OAuth redirect URIs do not change (same hostnames). GitHub webhooks do not change.
9. Abort path at any step before 7: scale the CDK services back up; the old database was never modified.
   After 7: switch DNS back and scale up; writes made on the new database in between are lost — state
   that plainly and keep the window short.
10. Hold 7 days: old stack kept but idle (services at 0, old database stopped; AWS restarts a stopped
    instance after 7 days, which matches the hold). Nothing is deleted during the hold.

**B. Cleanup PR (after the hold)** — delete `infra/cdk/`, `buildspec.yml`, `buildspec.agentcore.yml`,
`infra/scripts/` (everything superseded: deploy, rollback, classify, retrigger, perimeter, snapshot,
alarms, ALB logs, CodeBuild config, AgentCore update/build), `.github/workflows/deploy-retrigger.yml`,
the `infra synth` job in `ci.yml`, the `cdk` scripts in the root `package.json`, the CDK and script tests
under `apps/web/__tests__/` (`agentcore-cdk-stack`, `agentcore-deploy-script`, `deploy-retrigger`,
`ecs-cdk-*`, `ecs-deploy-*`, `ops-alarms-script`, `production-deploy-classifier`, `rds-perimeter-script`,
`snapshot-rds-script` — only after confirming each invariant was ported in WP-11/12/15), the CDK
exclusions in the portability test (WP-02), the "CDK (until cutover)" doc section. Move the GitHub OIDC
provider and eval role into `00-foundation` state (`terraform import`, documented) before the
`AiWorkspaceEvalCiStack` is deleted. Update `nightly-evals.yml` and `product-smoke.yml` to the new role
variable.

**C. Rob's AWS deletions (runbook section, not automated):** CloudFormation stacks
`AiWorkspaceEcsStack`, `AiWorkspaceDeployTasksStack`, `AiWorkspaceAgentCoreSpikeStack`,
`AiWorkspaceEvalCiStack`, `CDKToolkit`; CodeBuild projects `ai-workspace-build` and
`ai-workspace-agentcore-build`; role `CodeBuildAIWorkspaceRole`; ECR repos `ai-workspace` and
`ai-workspace-agentcore-agent` (after confirming no task definition references them); old secrets after
30 days; security group `sg-019e87b5938a295a4`; the old database after a final retained snapshot; the
script-made SNS topic and alarms; the `local-dev` user's `AmazonBedrockFullAccess` if unused; the default
VPC is left alone.

**Acceptance** `aws cloudformation list-stacks` shows no application stacks; drift job empty for
`personal-stage` and `personal-prod`; one restore drill and one revert-rollback recorded; monthly cost
before and after stated; #467 and #697 closed with links.

---

# Part F — After this spec

These are deliberately not specified to WP level yet. Write their specs when their trigger arrives.

| Item | Issue | Trigger | Notes for whoever specs it |
|---|---|---|---|
| Microsoft 365 connector | #984 | A Koch or test Entra tenant exists | Copy the Google facade pattern (ADR 0005, `apps/web/lib/google/*`, `/api/mcp/google`); read tools first; port the Gmail/Calendar eval suites |
| Koch landing | #985 | WP-07 answers + clean rehearsal | Add `envs/koch-*`; `10-network` in adopt mode; nothing else in the Terraform should need to change — if it does, that is a bug in Part B |
| Tier 2 (100 users) | #986 | Pilot stable four weeks | Worker `SKIP LOCKED` + fairness + queue-depth autoscaling; RDS Proxy (`enable_rds_proxy`); SSE instead of 500 ms polling; OTel; SCIM calling `user-lifecycle.ts` |
| Tier 3, Tier 4 | #986 | See the ladder | Group substrate builds on `user_groups` from WP-17 |

---

# Appendix A — CDK to Terraform map

| Today (CDK or script) | Terraform home |
|---|---|
| Default VPC lookup, public subnets | `10-network` (create or adopt) |
| Security groups web/worker/browser-proxy/studio-browser/deploy-task; rules added to imported DB group | `10-network` |
| `reconcile-rds-perimeter.sh` | removed; rules are state, drift job detects changes |
| RDS `ai-workspace-db` (hand-made) | `20-data` (`restore_snapshot_id` at cutover) |
| Secrets `ai-workspace/production/app`, `…/browser-proxy-db` (hand-made), `…/browser-proxy` (CDK) | `20-data` shells / generated |
| ALB log bucket (`setup-alb-access-logs.sh`) | `20-data` |
| ECR `ai-workspace` (hand-made), `ai-workspace-agentcore-agent` (CDK) | `00-foundation`, immutable |
| ACM certificate, Route 53 records | `30-platform` (optional by variable) |
| ECS cluster, Cloud Map namespace, ALB, listeners, target group | `30-platform` |
| Web/worker/proxy task definitions and services, autoscaling, task roles | `40-services` via `modules/ecs-service` |
| Migrator and smoke task definitions (`AiWorkspaceDeployTasksStack`) | `35-deploy-tasks` |
| Policies bolted onto `CodeBuildAIWorkspaceRole` by three stacks | `ci-identity` apply role |
| `ai-workspace-deploy-retrigger` role and workflow | removed; the apply workflow is triggered by Git, with a concurrency group |
| AgentCore runtime, role, credential provider, child CodeBuild project | `50-agentcore`; image built by `build-release.yml` |
| `BrowserCustom` Studio Browser | `50-agentcore` |
| CDK alarms + `setup-ops-alarms.sh` alarms, SNS topic | `60-observability` |
| GitHub OIDC provider, `ComparativeGitHubEvalsRole` (`AiWorkspaceEvalCiStack`) | `00-foundation` / `ci-identity` |
| `CDKToolkit` bootstrap | removed |
| CodeBuild parent project, webhook, role (console) | removed; GitHub Actions |

# Appendix B — Things this spec does not know (verify, do not assume)

1. Whether `NODE_USE_ENV_PROXY=1` on the pinned Node 24 covers `node:https` callers (WP-03 decides).
2. Whether AgentCore runtime and browser work in VPC mode with endpoints only, and what IAM that needs
   (WP-13 spike).
3. Whether any non-`us.` inference-profile prefix is invocable for the enabled Claude models (WP-02 note;
   #971).
4. The exact metrics and thresholds of the five script-made alarms (read `setup-ops-alarms.sh` in WP-12).
5. Whether GitHub Enterprise at Koch exposes an MCP endpoint and at what URL (#971).
6. Current AWS prices for endpoints, NAT and Multi-AZ RDS — recompute in the PRs that quote costs.
7. Which admin workflows depend on the cross-user read that WP-18 removes (enumerate in that PR).
8. Whether Koch mandates Terraform Enterprise, a module registry, or a policy set that replaces `policy/`.
