# Roadmap — user journeys, integrations, and flagship use cases

> Companion to [`ARCHITECTURE.md`](./ARCHITECTURE.md) (the end-state
> picture) and [`PLAN.md`](../PLAN.md) (the weekly ship plan).
>
> [`PLAN.md`](../PLAN.md) sequences **construction** (which week each
> piece ships). This doc sequences **product surface** — the user
> journeys we're building toward, the integrations that feed them,
> and the named use cases each integration unlocks. The two map onto
> each other but answer different questions: PLAN is "what am I
> building this Friday"; this doc is "what experience are we shaping,
> and how does the catalog grow to support it".
>
> **Status as of July 2026:** Every journey now has shipped surface. **J1** chat is mature (business file/image uploads, native image blocks for screenshots, work receipts, first-run tour, slash-command palette, quiet recommendation cards). **J2** runs GitHub, Gmail, Google Calendar, and Notion through governed user connections, and the **Skills** catalog made saved agents real. **J3** is now complete for its first event source: leased schedules plus signed GitHub PR-review and failed-CI triggers run Skills into designated threads and notify users; optional email delivery remains tracked separately in #291. **J4** has its thin slice plus artifact revision consolidation and conversational app iteration; #133 tracks the broader app platform. **J5** supports named Skill and App shares with recipient credentials and owner revocation. Fast chat and interactive tools run on **AWS Bedrock**; durable, Skill, scheduled, and event-triggered worker lanes execute on **Bedrock AgentCore in our account**. The product runtime no longer depends on the Cursor SDK. The run ledger is `runs`; "recipes" are **Skills** everywhere. Salesforce, ServiceNow, SAP, Workfront, and Databricks remain next-integration work.
>
> **Product boundary:** AI Hub is a thin enterprise wrapper around existing AI and work platforms. It should remove friction, centralize governance, and make tools discoverable; it should not rebuild Bedrock, M365, Salesforce, Workfront, Databricks, specialized IDEs, or deployment platforms unless that layer is needed for control, audit, portability, or user experience.

## Platform maturity & hardening arc (added 2026-07-19)

The five journeys above are the **product** axis. This section is the **platform** axis: the work that takes Comparative from "strong alpha" to "passes an enterprise security review," plus the architecture and harness research now being brought into build. It exists because the [2026-07-19 self-review](reviews/REPO-SELF-REVIEW-2026-07-19.md) returned verdict **EVOLVE** with a clear message — the biggest risk is not any single bug but operational/security *readiness* lagging the code's ambition. Decisions that ground this arc are recorded as [ADRs](adr/).

*(Branding note: this doc still says "AI Hub"; the product is **Comparative** in the UI — drift tracked in #450, not fixed here.)*

### Hardening epic — [#453](https://github.com/DadJokez/AI-workspace/issues/453)

Two tracks, sequenced by safety-per-effort.

**Track A — Security & Auditability to 5/5** (the explicit target: the areas an enterprise security team scores). Authz correctness + tests (#445, #444), zero unframed injection channels (#454), zero high/critical CVEs behind a CI gate (#446, #459), key separation (#455), governed egress (#439), runtime policy *enforcement* (#410 P2, #436), **audit completeness by construction regardless of lane** (#456, blocked by #442), a **tamper-evident audit log** (#457), privileged-access logging (#458), a documented data lifecycle (#460), and the readiness packet — threat model + incident runbook + data-flow sheet (#461).

**Track B — Scorecard lift** (every dimension that scored under 4 → 4+): architecture via the `executeChatTurn` extraction (#442), run-lifecycle + resiliency (#443, #464), SSE-contract hardening (#465), the ops floor (#449), performance (#447, #448, #466), concurrency integrity (#463, #462), consistency + dead-code cleanup (#468, #469), release engineering (#467), and the doc/ADR re-baseline (#450, ADRs).

**First three moves** (highest leverage): `executeChatTurn` (#442) → run-lifecycle fencing + reaper (#443) → ops floor (#449). These buy the most safety per day of anything on the board.

### Architecture research → build (the vendored spec series)

Five research specs in [`docs/specs/`](specs/) are now broken into tracked build tracks:
- **Connector governance** → tri-state policy + connection-lifecycle audit + `/admin/connectors` (#410, P1 shipped observe-mode).
- **Publish tier** → SSO-gated `/apps/{slug}` with tri-mode data badges (#411); live-via-viewer already shipped as #407.
- **Skills extensibility** → versioning + vetting + namespacing (#412, day-one rails shipped).
- **Memory scopes** → four-scope Vault + constraint pinning (#413; pinning shipped as #416).
- **Orchestration** → Tier-1 worker pipeline (#422) on a runs tree (#423) feeding scheduled data-slot refresh (#424).

### Harness excellence → adoption (the Codex research)

The [Codex-harness research](https://github.com/DadJokez/AI-workspace/issues/440) surfaced four verified patterns worth adopting, each a spec-issue: autonomy presets (#436), proposal-first run outputs (#437), layered standing instructions (#438), and egress governance (#439). These reinforce Track A — governance the harness expresses as user-legible presets rather than buried policy.

## User journeys

The workspace is built around **five canonical user journeys**,
sequenced by build order. Everything else in this doc — agent
platform, integration tiering, flagship use cases — is in service
of moving users through these. They're the north star.

### J1 — Chat ✅ Shipped

A user opens the workspace, types into a thread, gets a streamed
response. Multi-turn, personal, interactive.

**Shipped:** chat threads with independent histories persisted per user, prompt/context guardrails plus the summary schema/helper, sidebar history, rename/delete, Stop/regenerate/edit-and-resend controls with persisted branch replacement, Bedrock model registry with assistant labels/default settings, GitHub OAuth sign-in / sign-out, admin panel (users + invitations), settings (theme, default model), Vault memory suggestions with approval controls and generated Markdown, common business file uploads with server extraction, native Bedrock image blocks for screenshots/images, quiet recommendation cards, full mobile responsiveness. Bedrock is the default runtime; AgentCore handles durable worker lanes. The deployment path is ECS/Fargate with automatic image builds, database migrations, and forced ECS service deployments on push to `main`; App Runner remains temporary rollback during cutover. Rolling summary generation itself remains pending.

### J2 — Chat with Tools 🔄 In Progress

The same chat surface, but the agent has access to the user's actual
work systems — GitHub, calendar, email, CRM, file storage, ticketing —
and can both **read** and **act**. "What PRs do I have open?"
returns a real answer; "Send Bob the summary" performs a real action.
This is what makes "talk to your work" real rather than aspirational.

**What's live:** GitHub MCP is working end-to-end - users connect via OAuth, tokens are stored encrypted in `oauth_tokens`, the GitHub server is represented in `mcp_servers`, and the Bedrock runtime mounts it per-user with a short-lived Bearer token on each tool turn. The tool catalog can constrain mounted MCP tools before they are registered with the model: provider-admin approvals stay broad, category/tool approvals expose only matching enabled catalog tools, and disabled catalog rows are hidden. Tool calls/results persist on chat messages after shared redaction and render as compact, expandable agent activity inside chat, MCP tool executions write redacted audit rows that admins can inspect at `/admin/audit`, registered servers/tools are visible at `/admin/tools`, long turns tolerate browser disconnects cleanly, chat turns are recorded in `runs` with runtime metadata and append-only `run_events`, and durable chat execution runs through a background-worker path with leases instead of requiring the `/api/chat` request to remain open. Running chat turns can be canceled, failed/canceled turns can be retried, and admins can request resume for queued/running runs. The manual Developer Briefing route persists redacted GitHub workflow runs in `runs` with an admin run list/detail UI, retry support for failed/canceled runs, reloadable activity, and a dated PR/CI aggregation prompt.

**What's next (Weeks 4–8):** M365 Graph (Mail + Calendar), Workfront, Databricks, Salesforce. See the integration tier table below. The auth pattern (HTTP MCP + per-turn Bearer) is proven; the remaining work is per-integration MCP servers and the OAuth plumbing for each provider.

**Requires for full J2:** broader integration catalogs for every MCP provider, provider-specific write safety reviews, production scheduling for audit retention, rate limits and quotas, and real OAuth/MCP implementations behind the expanded integration catalog.

### J3 — Proactive Agent ✅ Schedules and GitHub events shipped (July 2026)

**Shipped:** `schedules` table + leased scheduler tick; timezone-safe cadences (DST-tested); scheduled runs land in designated threads through the shared seam and execute on AgentCore. Signed GitHub repository webhooks now start owner-scoped Skill runs for PR reviews and failed CI, with durable delivery dedupe, rate limiting, prompt-injection framing, audit provenance, notifications, pause, and delete controls. Optional email delivery remains tracked in #291 rather than blocking the J3 product loop.

The same chat-with-tools agent, invoked on a **schedule** or in
response to an **event** instead of a user keystroke. "Every Monday
at 8am, summarize the past week and post it as the week's Status
thread." "When a new email matching `from:ceo@*` arrives, draft a
reply for me to review."

Both trigger types create ordinary `runs` rows and use the same worker,
runtime, provider gate, audit, and notification paths as user-started Skills.
Additional event sources remain incremental integrations rather than a new
automation runtime.

### J4 — App Build and Deploy 🔄 Thin slice shipped (June 2026)

**Shipped (thin slice, #133 tracks the full epic):** chat-built HTML artifacts deploy one-click into the `apps` registry, served SSO-gated at `/apps/{slug}` with a restrictive CSP; native artifact version groups with v2/v3 pills, download/preview, versions + plain-language revert; conversational updates resolve the current app artifact and create a new deployable draft version; no-secrets scan at save; sharing built in. **Not yet:** git/pipeline substrate and per-app services.

A user describes a small internal web app in conversation. The
workspace agent writes the code, shows a preview, iterates with the
user, and on **Deploy** provisions everything needed to run it:
a GitHub repo, a build pipeline, and a new AWS-hosted service. The
app is reachable only through the workspace — the workspace is the
**IdP**, and apps trust workspace-issued tokens via SSO. New apps
appear in the sidebar under **Apps**, where teammates with the right
access can discover and use them.

This is the biggest value unlock in the product: a non-technical user
goes from "I wish we had a tool that…" to a live running app, with
auth and discoverability and shareability handled, without leaving
chat.

**Remaining for the full journey:** expand the shipped code-generation and
artifact iteration loop into a deploy controller that creates the repo, kicks
the pipeline, and provisions a target AWS service; then extend the existing SSO
seam and Apps registry to those independently hosted services.

#### Git abstraction

Git is the storage and pipeline substrate, but it is **invisible to
end users**. Nobody sees a branch name, a diff hunk, a merge button,
or a commit hash. The user-facing surface is two verbs:

- **Save draft** — the agent commits the current state on the user's
  behalf and writes the commit message itself, summarized from what
  it just changed ("Added the export-to-CSV button on the dashboard
  page"). Cheap, frequent, on every meaningful agent edit.
- **Deploy** — the agent merges the session's work to `main`, kicks
  the build pipeline, and reports back when the new version is live.

**Branching is fully managed.** Every chat session that touches an
app gets its own feature branch behind the scenes; "Deploy" merges
that branch into `main` and triggers the pipeline. If the user
abandons the session, the branch is orphaned, not surfaced. If two
sessions edit the same app, the workspace serializes them — start
with a simple lock per app (one editor at a time) and consider
last-write-wins or three-way merge later if collaboration patterns
demand it.

**No-secrets policy is enforced by the agent.** The codegen loop
never writes `.env` values, API tokens, signing keys, or other
credentials into committed files. Anything credential-shaped goes to
AWS Secrets Manager/KMS and runtime config via the deploy controller, not into
the git history.

**Version history is "previous versions", not git log.** The Apps
detail view shows a list of "saved drafts" and "deployed versions"
with timestamps and the agent's plain-English summary of each. "Go
back to the version from yesterday" is a one-click action; the
underlying mechanic (revert commit, redeploy) is hidden.

**Failure messages are plain English.** The two edge cases that need
the most design care:

1. **Concurrent edits.** When the lock blocks a second session, the
   user sees "Alice is editing this app right now — try again in a
   few minutes" rather than a merge conflict. When a true conflict
   is unavoidable (rare, but possible in an unlock-and-merge model),
   the agent reconciles in conversation: "I have two sets of changes
   here — let me show you both and ask which to keep."
2. **Deploy failures.** Build / pipeline / AWS runtime errors get
   translated by the agent into actionable text — "The new version
   didn't build because of a typo in the dashboard page (line 42).
   I'll fix and try again." — not a stack trace or a CodeBuild log
   id. Raw errors stay in the deploy controller's logs for us; the
   user sees what to do next.

**Change-management burden** for non-technical users with this
framing is essentially zero. "Save draft" and "Deploy" are concepts
anyone who has used Google Docs and clicked a Publish button already
understands. The complexity of git, branches, conflicts, and CI lives
behind the agent — surfaced only when (and how) the agent decides
the user needs to make a decision.

### J5 — Share 🔄 Seed shipped (June 2026)

**Shipped:** skills and apps share to named teammates via the generic `shares` table — recipients run/open with their **own** credentials, never the owner's; owners revoke; recipients clone. **Not yet:** thread sharing, org-wide visibility, the catalog/feed distribution surface (#78).

Any artifact in the workspace — a chat thread, a scheduled agent
config, a deployed app — can be shared with named teammates,
distributed via a catalog (the recipes / skills surface in
ARCHITECTURE.md), or made discoverable workspace-wide. Access control
lives in the workspace, not in the underlying integrations or apps.
Shared items appear in recipients' sidebars in the appropriate
section (History, Scheduled, Apps).

**Cuts across J1–J4.** Sharing a chat thread is one shape; sharing a
recurring scheduled agent ("subscribe to Rob's weekly status") is
another; sharing a deployed app (granting access to the app's
workspace-SSO realm) is another. The mechanics differ; the user
mental model — "make this available to Alice" — is the same.

### How the rest of this doc maps onto the journeys

- **Agent Platform** (Tool use via MCP → Scheduling → Event triggers)
  is the runtime substrate for **J2 and J3**.
- **Integration catalog** (Tier 1 / 2 / 3) populates the set of tools
  available to **J2**, and by extension to **J3** and the flagship
  use cases.
- **Flagship use cases** (Meeting Prep, Weekly Status, Customer
  Account Briefing, etc.) are concrete instances of **J2** — recipes
  that exercise specific tool bundles to deliver named value props.
  Some of them (recurring status, ticket triage) graduate naturally
  to **J3** once scheduling lands.
- **J4 (App Build and Deploy)** has no home in the rest of this doc
  yet; it's the next major scope expansion and will get its own epic.
- **J5 (Share)** is cross-cutting: every artifact this doc describes
  needs a shareability story before the workspace is "done".

## Tiering

Every system of record is one of three tiers based on the ratio of
**user reach × use-case density × auth-and-API tractability**.

| Tier | Criteria | What we commit to |
|---|---|---|
| **Tier 1 — Core** | Used by >50% of GP knowledge workers; powers >2 flagship use cases; auth pattern is well-understood (delegated OAuth or service-principal we already run). | First-class MCP server, full tool surface, in the recipe catalog from launch. |
| **Tier 2 — Functional** | Used by a specific function (IT, eng, support); powers 1–2 flagship use cases; auth and API tractable but not yet vetted. | MCP server in the catalog, narrower tool surface, ships once Tier 1 is stable. |
| **Tier 3 — Strategic** | Long-tail or transformational; auth/API has real friction (SAP) or the architectural pattern is novel (agent-authored notebooks or deployed apps). | Spike-then-decide. RFC + PoC before committing to a server. |

## Tier 1 — Core integrations

| System | MCP slug(s) | Auth model | Why Tier 1 | Status |
|---|---|---|---|---|
| **GitHub** | `github` | GitHub OAuth per-user; short-lived Bearer over HTTP MCP at `api.githubcopilot.com/mcp/` | First live integration — proven the auth pattern (OAuth flow → `oauth_tokens` → per-turn Bearer). Powers Developer Workflow; feeds Agent Wire. | ✅ **Live** |
| **Notion** | `notion` | Notion OAuth per-user; encrypted delegated token in `oauth_tokens`; runtime mount waits for a compatible bearer-token MCP gateway via `NOTION_MCP_ENDPOINT_URL` | Team docs and databases. OAuth connection ships first so users can link accounts from Tools; full read/query execution follows once the gateway endpoint is approved. | OAuth connection |
| **Office 365** (Mail, Calendar, OneDrive, SharePoint, Teams) | `graph-mail`, `graph-calendar`, `graph-files`, `teams` | Entra delegated OAuth (per-user); short-lived Bearer over HTTP MCP | Universal reach — every employee. Powers Meeting Prep, Weekly Status, Morning Briefing. Auth pattern matches GitHub MCP exactly; needs GP IT Entra app registration approval. | wk 4 (Graph mail+cal) · wk 8 (Files+Teams) |
| **Salesforce** | `salesforce` | Salesforce OAuth 2.0 per-user; HTTP MCP with per-turn token | Account-and-pipeline data is the highest-value non-Microsoft surface. Powers Customer Account Briefing and enriches Weekly Status. | wk 9–10 (after M365 stable) |
| **Databricks + S3 + Redshift** | `data-lake` (single MCP, three backends) | Databricks service principal (M2M); IAM role for S3/Redshift. Stdio. | Data team's three sources are always queried together. One unified server with backend-aware tools keeps recipe definitions clean. | wk 8 |
| **Workfront** | `workfront` | Workfront OAuth per-user; HTTP MCP | Project, task, status, capacity. Pairs with Mail/Cal for Weekly Status. Cross-system test for non-Microsoft delegated OAuth. | wk 8 (pick Workfront or Databricks whichever IT clears first) |

**Why these four together:** any Tier 1 user can answer "what am I
working on, who do I owe what, who's asking me about it, what's the
data say" without leaving the chat. Everything in Tier 2/3 layers on
top of this base.

## Tier 2 — Functional integrations

| System | MCP slug(s) | Auth model | Why Tier 2 | Earliest week |
|---|---|---|---|---|
| **ServiceNow** | `servicenow` | OAuth (per-user) for the requesting user's tickets; service principal for queue-wide reads. | Powers IT Request Agent and is the right surface for "what's the status of my ticket / open one for me". Reach is broad but it's a once-a-month tool for most users — value-per-user is medium, not Tier 1. | wk 12+ |
| **GitHub + Azure DevOps** (unified) | `code-platform` (one MCP, two backends) | GitHub: PAT or GitHub App; ADO: PAT or service principal. Stdio for service-account paths; HTTP for per-user PR reads. | Unified for the same reason as the data-lake server: engineers move between them; recipes shouldn't care. Powers Developer Workflow and feeds Agent Wire. | wk 13+ |
| **Agent Wire MCP** | `agent-wire` | M2M to S3/Athena via IAM role. Stdio. | Once the S3/Athena dataset has shape (and the schema review in [`ARCHITECTURE.md`](./ARCHITECTURE.md) is done), Agent Wire becomes its own MCP. Read tools only initially: `query_engineer_activity`, `summarize_repo_velocity`, `top_skills_by_usage`. **Build only after schema review.** | wk 14+ (gated on schema review) |

## Tier 3 — Strategic / spike-first

| System | MCP slug(s) | Auth model | Why Tier 3 | Approach |
|---|---|---|---|---|
| **SAP ERP** | `sap-erp` (TBD; possibly split by module — FI, MM, etc.) | OAuth via SAP BTP, or service-principal via SAP API Gateway. Likely both, depending on the module. Auth is the hard part. | Highest-value strategic target — finance, procurement, supply chain. SAP Budget Query (below) is the wedge use case. Risk: SAP API surface is module-specific, naming is its own dialect, every transaction code is its own auth scope. | RFC first. PoC against one module (likely FI for the budget use case). Re-tier after PoC. |
| **Agent-authored Databricks notebooks** | n/a - this is a workload, not an integration | AgentCore worker using Databricks workspace credentials (service principal); reads/writes notebooks via Workspace API. | Different shape than the others: instead of "chat about Databricks data", this is "write the notebook that does the analysis, and run it". Closes the loop from "ask a question" to "ship the analysis". Architecturally novel - needs the runtime seam to be solid first. | RFC after Tier 1 Databricks ships. Likely a separate skill pattern, not an MCP server. |

## Agent Platform

The integration catalog above defines **what data agents can reach**.
The agent platform defines **what agents can do** with that data —
how they take action, how they run on a schedule, and how they react
to outside events. It's the runtime layer the catalog plugs into.

### AWS runtime reality check

Bedrock and AgentCore are now the governed runtime stack. Direct chat and
interactive tool turns use Bedrock because they need low latency and simple
streaming. Durable work uses AgentCore because it needs session isolation,
worker ownership, reconnect/retry semantics, and AWS-native governance.

The runtime is not the enterprise product boundary. AI Hub still owns
identity, thread/runs persistence, bounded context, token storage, provider
attestations, audit logging, quotas, redaction, retention, schedules, delivery
destinations, and the user-facing skills catalog.

Current implementation notes:
- AI Hub passes bounded prior context into each turn and keeps product memory
  in Postgres.
- Provider/category/tool attestations are enforced before MCP tools are exposed
  to the model. Broad provider-admin approval can still expose uncataloged
  tools, but category/tool approvals only expose enabled catalog matches.
- Subagents and parallel tool work are promising, but they are not a J1-J3
  dependency. Use them only after the simpler tool/schedule path is stable.

### Capabilities progression

1. **Tool use via MCP.** Every action an agent takes — read a
   calendar event, send a Slack message, query a warehouse, write a
   file in SharePoint — is a tool exposed by an MCP server pointed
   at one of the integrations above. There are no in-process tool
   handlers and no agent-side closures masquerading as tools: a new
   capability is always a new MCP tool, never a new shim in the
   agent code. This is the bridge between the integrations catalog
   and agents that **actually do things**, and it's the precondition
   for everything below.
2. **Scheduling layer.** A thin wrapper on top of the runtime seam: schedules
   live in a DB table, a cron worker wakes on the cadence, creates a run with
   the skill prompt, and streams the result
   back into the originating thread (or a designated output
   channel). AgentCore has no product-level cron, so this is our own layer -
   but it's small (a worker, one table, one trigger row per
   schedule). Unlocks "Monday 8am: send me my weekly status" without
   the user remembering to invoke anything. PLAN.md week-5 already
   sequences this; the dependency on tool-use is implicit.
3. **Event / webhook triggers.** "Run agent when X happens" — new
   email matching a filter, calendar event 15 minutes out, form
   submission, GitHub PR opened, ServiceNow ticket assigned to me.
   Same shape as scheduling but the trigger is an inbound event
   rather than a clock. This is the step that turns recipes from
   user-invoked tools into **autonomous agents**.

The order is load-bearing: tool use is the foundation, scheduling
is the first form of autonomy (time-driven), event triggers are
the second (state-change-driven). Each builds on the prior — there's
no "schedule a recipe" without tool calls to schedule, and no useful
event trigger without both.

### Constraints

- **All tools must be MCP servers.** No in-process function
  handlers, no agent-side closures pretending to be tools. This
  keeps the capability surface inspectable, auditable, and reusable
  across recipes; it's also what lets the audit log and the provider/category/
  tool attestation gate work uniformly across every mounted integration.
- **Subagents and parallel task execution are optional acceleration.**
  AI Hub should prove the simple J2/J3 tool-and-schedule path first.
  Parallelism belongs in skills only where
  the work is independent, quotas are understood, and audit output stays
  legible.

## Flagship use cases

Each one is a recipe (or a tight family of recipes) with a known
shape, a known audience, and a clear list of MCP dependencies. The
order roughly follows the tier rollout — early use cases need only
Tier 1, later ones reach into Tier 2/3.

### 1. Meeting Prep

> *"I have a meeting with Acme at 2pm. What do I need to know?"*

- **Who:** sales, account managers, anyone with external meetings.
- **Inputs:** calendar event id (or "next meeting on my calendar").
- **MCP deps:** `graph-calendar` (the event), `graph-mail` (recent
  threads with attendees), `teams` (recent chats), `salesforce`
  (the account record + open opps + recent activity).
- **Output:** one-page brief — attendees, agenda, last touch, open
  items, three suggested questions.
- **Earliest:** week 9–10 (needs Salesforce).

### 2. Weekly Status

> *"What did I do this week, and what's blocked?"*

- **Who:** ICs writing weekly updates; managers reviewing them.
- **Inputs:** week range (default: current).
- **MCP deps:** `workfront` (tasks moved/completed), `graph-mail`
  (sent items as a proxy for activity), `teams` (replies in
  channels), `code-platform` (PRs merged) — the last one moves
  this from "non-engineer status" to "any-discipline status".
- **Output:** bulleted week-in-review, pre-tagged for the user's
  manager's preferred format.
- **Earliest:** week 8 with Tier 1; richer at wk 13+ with `code-platform`.

### 3. Data Exploration for non-analysts

> *"What were our top 10 SKUs by margin in Q1, and how does that
> compare to Q4?"*

- **Who:** product managers, sales ops, finance, anyone who'd
  otherwise file a ticket with the data team.
- **Inputs:** a question in plain English.
- **MCP deps:** `data-lake` only (Databricks + S3 + Redshift, the
  unified server). The recipe's system prompt encodes the warehouse
  conventions and the most common tables; the model writes SQL,
  runs it, summarizes results, shows the SQL on demand.
- **Output:** answer + the SQL it ran + a chart for tabular results.
- **Earliest:** week 9 (after `data-lake` lands wk 8 and gets a
  shake-out).
- **Note:** this is the use case most likely to drive recipe
  cloning — every team has its own "common questions" version.

### 4. Customer Account Briefing

> *"Give me the state of the Acme account."*

- **Who:** account execs, customer success, exec stakeholders before
  a renewal call.
- **Inputs:** account id or name.
- **MCP deps:** `salesforce` (account, opps, contacts, activity),
  `graph-mail` + `teams` (recent comms with the account's domain),
  `data-lake` (revenue / usage / health metrics).
- **Output:** structured brief — relationship status, open
  opportunities, recent comms, usage trend, risks.
- **Earliest:** week 11+ (Salesforce + data-lake).

### 5. IT Request Agent

> *"My laptop is slow / I need access to X / what's the status of
> ticket INC0034521?"*

- **Who:** every employee, occasionally.
- **Inputs:** plain-language description.
- **MCP deps:** `servicenow` (search KB, look up status, open
  ticket on confirm), `graph-mail` (related correspondence).
- **Output:** either a KB answer (deflection), a status update, or
  a ticket-creation confirmation. Always with a "talk to a human"
  escape hatch.
- **Earliest:** week 12+ (ServiceNow).
- **Note:** the **first recipe with destructive side effects** —
  needs lower-level tool/category policy enforcement to be solid and a
  human-in-the-loop confirmation step before any `create_*` call.

### 6. Developer Workflow

> *"What PRs am I reviewing? Which of mine are stalled? Anything
> failing CI? Summarize the diff for #1234."*

- **Who:** engineers, eng managers.
- **Inputs:** none (defaults to "me, this week"); or a PR id.
- **MCP deps:** `code-platform` (GitHub + ADO unified),
  `graph-calendar` (don't summarize during meetings),
  `agent-wire` (only for "team-wide" variants — "what's our
  team's PR throughput trend?").
- **Output:** triaged list with one-line summaries; for a
  specific PR, a structured diff brief.
- **Earliest:** week 13+ (`code-platform`); richer with
  `agent-wire` (week 14+).

### 7. SAP Budget Query

> *"What's the actual-vs-budget for cost center 4231 YTD?"*

- **Who:** finance, cost-center owners, occasional execs.
- **Inputs:** cost center, period.
- **MCP deps:** `sap-erp` (FI module reads). Optionally `data-lake`
  if the canonical reporting is mirrored to Databricks.
- **Output:** the number, the variance, the trend, the top 5 line
  items driving it.
- **Earliest:** post-RFC. Tier 3 — could be quarter 3, could be
  next year, depending on what the SAP PoC finds.
- **Note:** picked deliberately as the SAP wedge use case because
  it's **read-only**, **canonical** (everyone wants the same
  answer), and **already a manual report** — so we have a
  ground-truth eval set on day one.

## Use-case → MCP dependency matrix

|  | `teams` | `graph-mail` | `graph-cal` | `graph-files` | `salesforce` | `data-lake` | `workfront` | `servicenow` | `code-platform` | `agent-wire` | `sap-erp` |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Meeting Prep | ✓ | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| Weekly Status | ✓ | ✓ |  |  |  |  | ✓ |  | ✓ |  |  |
| Data Exploration |  |  |  |  |  | ✓ |  |  |  |  |  |
| Customer Account Briefing | ✓ | ✓ |  |  | ✓ | ✓ |  |  |  |  |  |
| IT Request Agent |  | ✓ |  |  |  |  |  | ✓ |  |  |  |
| Developer Workflow |  |  | ✓ |  |  |  |  |  | ✓ | (✓) |  |
| SAP Budget Query |  |  |  |  |  | (✓) |  |  |  |  | ✓ |

The pattern: Tier 1 covers 5 of 7 flagships outright. Tier 2 unlocks
the remaining two and **enriches** the others (Developer Workflow
and Weekly Status get materially better with `code-platform`).
Tier 3 is incremental on Tier 1+2.

## Skills catalog flywheel

The catalog is not a static list of recipes — it's a feedback loop
between **integrations**, **recipes**, and **usage signal**.

```
   ┌──────────────────────┐         ┌──────────────────────┐
   │  New MCP server      │────────▶│  More recipes possible│
   │  (e.g. data-lake)    │         │  (clone + adapt)      │
   └──────────────────────┘         └──────────┬───────────┘
            ▲                                   │
            │                                   ▼
   ┌──────────────────────┐         ┌──────────────────────┐
   │  Schema/tool refactor│         │  Recipes get used    │
   │  driven by usage     │◀────────│  (recipe_runs grow)  │
   └──────────────────────┘         └──────────┬───────────┘
            ▲                                   │
            │                                   ▼
   ┌──────────────────────┐         ┌──────────────────────┐
   │  Agent Wire surfaces │◀────────│  Audit / wire events │
   │  patterns + gaps     │         │  to S3 / Athena      │
   └──────────────────────┘         └──────────────────────┘
```

The flywheel turns when each loop is intact:

1. **Integration → recipe.** Every new MCP server multiplies the
   number of recipes the catalog can host. The `data-lake` MCP
   alone unlocks Data Exploration, the data side of Customer
   Account Briefing, and any team-specific variant of either.
2. **Recipe → usage.** Recipes only matter if they get cloned and
   run. The week-6 catalog UI (clone + edit + schedule) is the
   distribution mechanism; the week-5 scheduling is what makes
   them sticky (a recipe that runs Monday morning beats a recipe
   the user has to remember to invoke).
3. **Usage → signal.** `recipe_runs`, the `audit_log`, and
   eventually Agent Wire's S3/Athena dataset turn usage into a
   measurable signal: which recipes spread, which MCP tools are
   slow or chatty, which auth flows fail most.
4. **Signal → refactor.** That signal feeds back into MCP-server
   tool design (split too-granular tools, merge redundant ones),
   recipe seeding (promote popular clones into starters), and
   integration prioritization (drop systems nobody touches; add
   the ones every team is asking for).

The point of the loop is that **we never have to guess what to
build next** once it's spinning. Until it is, we're seeding it
deliberately — Tier 1 first, 5–10 starter recipes by hand, then
let Agent Wire start telling us where to invest.

## Open items

1. **Data-lake unification — one MCP or three?** The plan above
   commits to one (`data-lake` covering Databricks + S3 +
   Redshift). The risk is that the three backends have very
   different latency/cost profiles, and a unified tool surface
   may hide that from the model. Decide after the wk-8 spike.
2. **Microsoft surface granularity.** `graph-mail`, `graph-cal`,
   `graph-files` are listed separately above; PLAN.md leaves it
   open. The argument for splitting is audit-log isolation and
   blast-radius limits per recipe; for merging, fewer auth
   round-trips and one place to fix Graph quirks. Default:
   split, revisit after wk 5.
3. **GitHub + ADO unification.** Same shape question as data-lake.
   GitHub is the strategic standard but ADO has heavy install
   base; engineers do move between them. One MCP feels right but
   needs validation against actual repo sprawl.
4. **Agent Wire schema review.** Blocking item for Tier 2 closeout.
   See [`ARCHITECTURE.md`](./ARCHITECTURE.md#agent-wire) for the
   specific questions. Owner and target date TBD.
5. **SAP RFC owner and timing.** Tier 3 — but the RFC itself can
   start as soon as Tier 1 lands. Decide whether Rob writes it or
   we recruit a finance-side partner to co-author.
6. **Catalog cold-start strategy.** Seed recipes ourselves, or
   pair-author with 3 design-partner users? See
   [`ARCHITECTURE.md`](./ARCHITECTURE.md#open-questions). Decide
   end of week 5.
7. **Naming.** "Recipes" vs. "Skills" — same concept, depends on
   which lands with the first business reviewer. Resolve before
   the catalog UI ships in week 6 so the URL and table names
   don't have to migrate.
