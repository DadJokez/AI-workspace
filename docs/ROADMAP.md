# Integration roadmap — MCP servers and flagship use cases

> Companion to [`ARCHITECTURE.md`](./ARCHITECTURE.md) (the end-state
> picture) and [`PLAN.md`](../PLAN.md) (the weekly ship plan).
>
> [`PLAN.md`](../PLAN.md) sequences **construction** (which week each
> piece ships). This doc sequences **integration coverage** (which
> systems we go after, in what tier, and which use cases each one
> unlocks). The two map onto each other but answer different
> questions: PLAN is "what am I building this Friday"; this doc is
> "where does the catalog grow next, and why".

## Tiering

Every system of record is one of three tiers based on the ratio of
**user reach × use-case density × auth-and-API tractability**.

| Tier | Criteria | What we commit to |
|---|---|---|
| **Tier 1 — Core** | Used by >50% of GP knowledge workers; powers >2 flagship use cases; auth pattern is well-understood (delegated OAuth or service-principal we already run). | First-class MCP server, full tool surface, in the recipe catalog from launch. |
| **Tier 2 — Functional** | Used by a specific function (IT, eng, support); powers 1–2 flagship use cases; auth and API tractable but not yet vetted. | MCP server in the catalog, narrower tool surface, ships once Tier 1 is stable. |
| **Tier 3 — Strategic** | Long-tail or transformational; auth/API has real friction (SAP) or the architectural pattern is novel (Cursor as a coding agent on Databricks). | Spike-then-decide. RFC + PoC before committing to a server. |

## Tier 1 — Core integrations

| System | MCP slug(s) | Auth model | Why Tier 1 | Earliest week |
|---|---|---|---|---|
| **Office 365** (Teams, Mail, Calendar, OneDrive, SharePoint) | `teams`, `graph-mail`, `graph-calendar`, `graph-files` | Entra delegated OAuth (per-user); short-lived Bearer over HTTP MCP | Universal reach — every employee. Every flagship use case touches it. Auth pattern (Entra delegated, KMS-encrypted refresh tokens) is already in the v2 plan. | Teams: wk 3 · Graph mail+cal: wk 4 · Files+SP: wk 8 |
| **Salesforce** | `salesforce` | Salesforce OAuth 2.0 user-agent flow (per-user); HTTP MCP with per-turn token | Account-and-pipeline data is the highest-value non-Microsoft surface. Powers Customer Account Briefing on its own and Weekly Status when crossed with Workfront. | wk 9–10 (after Tier 1 Microsoft is stable) |
| **Databricks + S3 + Redshift (unified)** | `data-lake` (single MCP server, three backends) | Databricks service principal (M2M); IAM role for S3; Redshift via IAM-auth or short-lived password from Secrets Manager. Stdio transport. | Data team's three sources are always asked together ("the warehouse"). Splitting them into 3 MCP servers makes recipes brittle — every "explore the data" recipe would have to declare all three. One server with backend-aware tools (`query_warehouse`, `list_lake_paths`, `read_lake_object`) lets the model and the recipe think in terms of the **data**, not the **store**. | wk 8 (the v2-plan "second integration" slot) |
| **Workfront** | `workfront` | Workfront OAuth (per-user); HTTP MCP with per-turn token | Project, task, status, capacity — the structured side of "what am I supposed to be doing". Pairs with Mail/Cal for Weekly Status and Meeting Prep. Cross-system test for the per-user-delegated-non-Microsoft pattern. | wk 8 (alternative second-integration; pick whichever IT clears first) |

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
| **Cursor as a coding agent on Databricks** | n/a — this is a workload, not an integration | Cursor SDK using Databricks workspace credentials (service principal); reads/writes notebooks via Workspace API. | Different shape than the others: instead of "use Cursor to chat about Databricks data", this is "use Cursor to **write the notebook** that does the analysis, and run it". Closes the loop from "ask a question" to "ship the analysis". Architecturally novel — needs the runtime seam to be solid first. | RFC after Tier 1 Databricks ships. Likely a separate recipe pattern, not an MCP server. |

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
  needs the `preToolUse` attestation gate to be solid and a
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
