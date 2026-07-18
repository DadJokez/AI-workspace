# Multi-Agent / Subagent Orchestration for Comparative (AI Hub)

**Status:** Research spec — no implementation. Produced from prompt `04-multi-agent-orchestration-research-prompt.md`, grounded against `TECHNICAL_OVERVIEW.md` (July 2026 snapshot of `ai-workspace`). Fourth of four (Memory → Skills → Connectors & Governance → **Orchestration**); it deliberately builds on the other three.
**Research method:** deep-research harness — 6 search angles, 25 sources fetched, 125 claims extracted, top 25 adversarially verified (3 independent refutation votes per claim): **17 confirmed (3–0 or 2–0/2–1), 0 refuted, 8 unverified-by-vote** (verifier votes lost to session limits; all eight are from primary vendor docs — Claude Code cloud docs, OpenAI Codex cloud docs — and quoted verbatim). Claims outside the top-25 budget are cited as *extracted, not adversarially verified*, each with a verbatim quote. URLs live as of **2026-07-17** (fetch date).
**Date:** 2026-07-17

---

## 0. Grounding: what Comparative already has

- **No true orchestration exists today.** Every chat/Skill/scheduled/event run is one `runTurn` per turn — one agent, one context, one model. Overview §10.6 explicitly parks it: subagents/parallel tool execution are "promising but explicitly *not* a J1–J3 dependency; only after the simple tool/schedule path is proven." This spec honors that sequencing.
- **Multiple asynchronous model invocations already happen around a request:** the memory-capture worker runs its own Sonnet invocations over transcript windows post-chat (separate ECS service), and the evals judge is a fixed distinct model (`packages/evals/src/judge.ts`) — "different model for a narrow background job" already exists in miniature.
- **The closest thing to multi-step coordination** is the Developer Briefing workflow — deterministic hand-written aggregation code, not multi-agent.
- **The substrate for both Tier 1 and Tier 3 already exists:** `runs` ledger + `run_events` + worker leases + AgentCore session-isolated worker lanes are exactly the durable-execution machinery orchestration needs. A `skills` row (system prompt, model, MCP server slugs, allowed tools, params schema) **is already shaped like a scoped worker definition.**
- **Per-agent least-privilege is a parameterization, not a new system:** tool mounting is already per-turn (attestations + `tools_catalog` + `mcp_server_slugs`), so scoping a worker down is passing a narrower set through machinery that exists.

---

## 1. The three-tier model as found in research

The three-tier structure the prompt hypothesized is confirmed across primary docs — Claude Code's own docs enumerate the coordination styles separately *(verified 3-0)* — plus a fourth pattern (dynamic workflows) that is genuinely distinct.

| Tier | Coordination mechanism | Isolation model | Typical failure mode | Cost profile |
|---|---|---|---|---|
| **1 — Subagents in one session** | Orchestrator spawns workers; **only a summary returns to the parent**; intermediate tool noise never enters parent context *(verified 3-0)* | Fresh context window per subagent, own system prompt, independent permissions; can't see parent history or sibling progress *(verified 3-0)* | Sibling blindness — conflicting implicit decisions when parallel workers can't see each other mid-flight (Cognition's core objection); over-delegation by the orchestrator when a direct approach was cheaper *(extracted)* | Agents ≈ **4×** chat tokens *(verified 3-0, Anthropic June 2025)*; each subagent is its own billed context |
| **2 — Local parallel teams** | Shared task list with dependency tracking; task claiming uses **file locking** to prevent races; teammates message the lead and each other directly *(extracted + verified 2-0)* | Separate sessions/context windows; **no automatic worktree isolation** — docs instruct partitioning so each teammate owns different files *(verified 3-0)* | Parallel write conflicts ("two teammates editing the same file leads to overwrites"); coordination overhead on sequential/dependency-heavy work *(extracted, primary docs)* | Token costs **scale linearly per teammate**; teams reported at ≈ **15×** standard usage *(extracted)* |
| **3 — Cloud/background agents** | Fire-and-forget: assign task, return later to a finished result (PR, report); triggered from UI, CLI, issue assignment, schedules *(unverified-by-vote, primary docs)* | Isolated ephemeral VM/sandbox per task (Anthropic-managed VM w/ scoped git-credential proxy; Copilot = GitHub Actions env; Jules = VM; Codex = per-repo cloud env) | Hard scope limits (Copilot: no cross-repo changes, **59-minute non-extendable session cap**); wrong fit for exploratory work | No separate compute charge in Claude's case — draws proportionately on the same rate limits; parallel tasks multiply usage |
| **(+) Dynamic workflows** | **The agent writes its own orchestration script** (JavaScript); a runtime executes it outside the conversation; intermediate results live in script variables, parent context gets only the final answer *(verified 2-0 + extracted primary)* | Script has **no filesystem/shell access itself** — only its spawned agents do; concurrency cap 16, total cap 1,000 agents/run; nesting limited to 1 level *(extracted, primary)* | Runaway scale/cost — vendor ships a "Large workflow" warning at >25 agents or >1.5M projected tokens *(extracted)*; not steerable mid-run | "Substantially more tokens than a typical session" — vendor's own words *(extracted, Anthropic announcement 2026-05-28)* |

### 1.1 The nested-delegation question — the prompt's premise is now false

The prompt asked whether "subagents cannot spawn subagents" is a hard limit or a default. **It was a documented hard rule for most of 2026, and it changed:** as of Claude Code **v2.1.172 (June 10, 2026)**, subagents can spawn their own subagents, capped at a **fixed, non-configurable depth of 5**; a depth-5 subagent simply doesn't receive the Agent tool *(verified 3-0 against current docs + changelog)*. Nesting is disabled per-agent by omitting the Agent tool. Two research-window blog sources (March and June 2026) still assert the old no-nesting rule — a useful reminder that this space moves monthly and stale citations abound. Elsewhere the limits differ and are real: Azure AI Foundry connected agents have a **hard max depth of 2** (exceeding it throws) *(extracted, primary)*; Claude agent teams disallow nested teams; workflow-in-workflow nesting is capped at 1 level.

Depth caps exist for a reason. Practitioner token math *(extracted, one blog — treat as heuristic, not gospel)*: if a leaf subagent's summary would be under ~500 tokens, or the parent could have done it in ~2 tool calls, delegation isn't worth the overhead.

### 1.2 The design mechanisms that matter (all verified against primary docs)

- **Per-agent least-privilege is first-class**: `tools` allowlist / `disallowedTools` denylist per agent definition, including MCP-server-level patterns (`mcp__<server>`, `mcp__*`); a read-only research agent = Read/Grep/Glob only, physically unable to write *(verified 3-0)*. **Sharp edge:** omitting `tools` inherits **all** tools — the default is maximal, not minimal *(extracted)*.
- **Per-agent model routing is first-class**: `model` field per agent (aliases or full IDs, default `inherit`), explicitly framed by Anthropic as cost control ("route tasks to faster, cheaper models") *(verified 3-0)*; policy syntax exists to *forbid* models per agent (`Agent(model:opus)` deny rules) *(verified 2-1)*.
- **Tracing exists but was built because it's needed**: workflow-spawned agents emit `workflow.run_id`/`workflow.name` OpenTelemetry attributes so a run can be reconstructed from telemetry *(verified 3-0)*; Anthropic's research post is blunt that multi-agent debugging requires full production tracing because agents are non-deterministic between runs *(extracted, primary)*.
- **Runaway-guards are recent and real**: per-session subagent spawn cap (default 200, v2.1.212); worktree-isolation bugs (subagents leaking git-mutating commands into the parent checkout) were being fixed as late as v2.1.206–210 *(extracted, changelog)* — i.e., even the best-resourced implementation of Tier 1/2 was still hardening file isolation in mid-2026.

### 1.3 The cost numbers and the counter-case (the honest core of this research)

- **Anthropic (June 2025, primary, verified 3-0):** agents ≈ **4×** chat tokens; **multi-agent systems ≈ 15×** chat tokens. Multi-agent economics is a *threshold condition*: "the value of the task must be high enough to pay for the increased performance." The same post reports the canonical upside datapoint: **Opus 4 lead + Sonnet 4 subagents outperformed single-agent Opus 4 by 90.2%** on their internal *research* eval — and, critically, names **coding as a poor fit** ("most coding tasks involve fewer truly parallelizable tasks than research").
- **Cognition (June 2025, "Don't Build Multi-Agents"):** parallel multi-agent collaboration "only results in fragile systems" — actions carry implicit decisions, and isolated parallel workers make *conflicting* implicit decisions *(extracted)*.
- **Cognition (April 2026 update — the position matured, not reversed):** the working pattern is **one writer, augmented by read-only intelligence contributors**; "most multi-agent setups in the world are limited to 'readonly' subagents"; isolated clean context beats shared context for reviewers because of context rot *(extracted, primary)*.
- **Anthropic's own when-NOT-to guidance (verified 3-0):** stay in the main conversation when the task needs frequent back-and-forth or iterative refinement, when phases share significant context, for quick targeted changes, and when latency matters (subagents start cold and must re-gather context).
- One blog attributes a "~7× worst-case" figure to Anthropic cost docs — it conflicts with the verified 15× (different denominators: subagent usage vs. full multi-agent research systems) and gave no URL. Treat 4×/15× (primary, verified) as the planning numbers.

**Synthesis of the two camps** — they agree more than they disagree: parallelize *reads* (research, verification, retrieval — independent, summarizable), never parallelize *writes* (one writer owns the artifact), and use isolation for **context hygiene and least privilege**, not for the illusion of a team.

### 1.4 Meta-orchestration and enterprise platforms (category survey)

- **AWS Bedrock AgentCore** — *Comparative's actual durable runtime* — ships first-class multi-agent support as of mid-2026: multi-agent workloads and the A2A protocol in Runtime; a **Policy service that intercepts every tool call through Gateway** (rules in natural language or Cedar); step-level trace Observability emitting OTel; Harness microVM sessions that work with **Bedrock, OpenAI, Gemini, and any OpenAI-compatible provider**; and a governed org-wide Registry for agents/MCP servers/tools/skills *(extracted, primary AWS docs)*. The cross-provider Harness makes AgentCore itself the most concrete "meta-orchestration layer" in this research.
- **Azure**: classic connected agents (natural-language delegation, per-agent identity) are **already deprecated** in favor of a workflows API (classic retires March 2027); Microsoft Agent Framework (agents-as-workflow-executors, .NET/Python/Go) was still prerelease in July 2026 *(extracted, primary)*. A one-year-old first-class multi-agent primitive already being replaced is a caution against building coordination surface prematurely.
- **Dynamic workflows** (GA May 28, 2026, across Claude Code CLI/Desktop/VS Code and on Bedrock/Vertex/Foundry) are the most interesting pattern for Comparative *later*: orchestration logic as an inspectable, saveable, rerunnable artifact — with enterprise controls already present (`disableWorkflows` managed setting, size warnings, OTel attributes) *(verified 2-0 + extracted)*.

Bottom line for the category: real, moving fast, immature at the edges. Nothing here is something Comparative should rebuild; AgentCore's primitives are things Comparative already sits on.

---

## 2. Recommended tier(s) for Comparative — and why

### 2.1 The call

**Build Tier 1 only, as invisible plumbing, in its minimal form: a sequential pipeline of 2–3 scoped workers per "build me X" request — a read-only data worker and a no-connector build worker under one orchestrator. Do not build Tier 2. Do not build a new Tier 3 — Comparative already owns one (J3), point it at artifact refresh. Defer dynamic workflows.**

Justification against the research:

1. **Comparative's request shape is sequential, not parallel.** "Pull data → build something visual → let me edit it" has almost no truly parallelizable subtasks — exactly the shape Anthropic says multi-agent is wrong for (coding/build work, few parallel branches) and Cognition says breaks under parallel writers. What the shape *does* reward is the other two benefits of Tier 1: **context isolation** (a Salesforce pull's raw rows and tool noise never pollute the builder's context — the same reason `buildTurnContext` guardrails exist) and **least privilege by construction** (§2.3). This is precisely Cognition's April 2026 production pattern: one writer, read-only contributors.
2. **Tier 2 fails every filter.** It's experimental and disabled by default in the best-funded implementation *(verified 2-0/3-0)*; its failure modes (file-ownership partitioning, write collisions) are developer-workflow problems Comparative's non-technical users should never see; and Comparative has no user-facing filesystem for teams to collide on anyway. Nothing in GP's flagship use cases needs simultaneous parallel sessions on one "machine."
3. **Tier 3 is the one tier Comparative has already built** — AgentCore session-isolated worker lanes + `runs` leases + `schedules` *are* fire-and-forget background agents with results delivered to a thread. The gap the prompt names (live artifacts only refresh while the app is open) is closed by *composing what exists*: a scheduled data-refresh run that re-executes the dashboard's data step and writes a new artifact/app version — not by adopting anyone's cloud-VM product. (The vendor Tier-3 offerings are all repo-and-PR shaped — Copilot's 59-minute cap and single-repo scope, Codex's per-repo environments — which is not Comparative's domain.)
4. **Sequencing honors §10.6.** Tier-1 workers should land *after* the Salesforce MCP integration (J2, wk9–10) proves the single-agent path — the orchestration is a refactor of how a turn executes, not a new user-facing feature, so it can ship quietly behind the same chat surface.
5. **Cost math supports the minimal form.** At ~4× tokens per delegated agent, a 3-worker sequential pipeline roughly triples-to-quadruples turn cost versus single-agent — acceptable for a high-value build request, and far from the 15× fan-out regime this spec deliberately avoids.

### 2.2 Exposure: invisible plumbing, with one visible surface

**Default position: users never see "agents."** No agent configuration, no team UI, no model pickers per worker. The research's clearest lesson is that orchestration is an implementation detail with sharp edges (cost multipliers, coordination failure modes) — exactly what a thin enterprise shell should absorb, not export to non-technical GP employees.

The one surface that should be visible: **the activity stream Comparative already has.** `run_events` replay already shows redacted tool activity; a worker pipeline appears there as labeled steps ("Fetching Salesforce data… Building dashboard…"). That's honest (grounding rule: never misstate what's happening), useful, and requires no new mental model. Admins additionally get the full per-worker breakdown in `/admin/runs` (§2.4).

Power-user configuration (choosing worker counts, models, parallelism) should **not** ship. If it's ever warranted, dynamic-workflows-style saved orchestration artifacts are the right shape — inspectable scripts, admin-gated (`disableWorkflows` precedent) — but that's a later decision, not launch scope.

### 2.3 Explicit connections to the other three specs

- **Skills (spec #2): a worker is a Skill-shaped thing.** The `skills` row already carries exactly a worker definition: system prompt, model, `mcp_server_slugs`, allowed tools, params schema. Recommendation: internal worker definitions should *be* (non-user-visible) Skill rows, so orchestration = the shell composing Skills — no second definition format, and the export/clone/share machinery stays coherent.
- **Connectors & governance (spec #3): per-worker scoping is the same machinery, narrowed.** The data worker mounts only the needed MCP server with only read-level catalog tools, checked against the *requesting user's* attestations as always; the build worker mounts **no MCP servers at all**. Every worker tool call produces the same `audit_log` row; the tri-state (`always_allow`/`needs_approval`/`blocked`) from the connector spec applies unchanged — a worker hitting a `needs_approval` write pauses the parent run. This is the connector spec's least-privilege principle applied at the agent level, verbatim.
- **Memory (spec #1): workers get context slices, not the Vault.** The orchestrator receives the Personal Context block as today; a worker receives only its task brief + the data payload it needs. Workers never write memory — memory capture remains the separate post-run pipeline, operating on the *parent* thread only. Per-Skill accumulated notes (memory spec's per-tool scope) attach to the worker's Skill row, satisfying "memory scoping per agent" without a new scope type.

One new schema need, shared by all of the above: **`runs.parent_run_id`** (plus a `step` label). It gives the audit trail, the activity stream, the cost rollup, and the tracing story a single spine. The `runs` table's "one generalized execution ledger" decision (`docs/RUNS_DECISION.md`) extends naturally to a tree.

### 2.4 Cost and model routing

**Rule: route by step type, decided by the shell's policy — never by the user.**

| Step | Model | Rationale |
|---|---|---|
| Orchestration / decomposition / final assembly | **Sonnet 4.6** (the pinned lane) | Judgment/synthesis is where frontier capability pays (Anthropic's lead-agent pattern; Cognition: cheap model "not good enough as the primary") |
| Data extraction against a *known* schema (templated SOQL, repeat refreshes) | **Haiku-tier** | The documented cheap-lane case: narrow, verifiable, high-volume. This is the Explore-agent-on-Haiku pattern *(extracted)* |
| First-time data exploration (schema unknown, query judgment needed) | Sonnet 4.6 | Query design is judgment, not extraction |
| Artifact build (the writer) | Sonnet 4.6 | The single writer owns quality |
| Optional verification pass (does the artifact render? do figures match the dataset?) | Haiku-tier | Narrow checking; the evals-judge precedent already exists in-repo |

Mechanically this is all latent capability the overview documents: the model registry defines `haiku-4-5`, `model_enablement` gates it (add a `worker` purpose row), and the routing pin only governs the *default chat lane* — per-run model metadata already exists on `runs`. **Caveat from the overview §3a:** Haiku's production enablement state is unverifiable from the repo; enabling it for a worker purpose is a deliberate admin/DB action, not a code change.

**Cost allocation (the AI-spend connection):** with `parent_run_id` + the token metadata `runs` already stores per run, per-step cost rollup is a query, not a system: cost per build, per Skill, per user, per model tier. This should be an explicit input to the Agent Wire schema review (overview §8, currently blocked) — add `parent_run_id` and `step` to the event taxonomy *now* so orchestrated runs are attributable from day one. Multi-agent orchestration is a cost-allocation decision as much as an architecture one; the 4×/15× numbers are the reason quotas (§9 enterprise-readiness gap) should land before any fan-out pattern ever does.

---

## 3. Worked example: the Salesforce dashboard build

User asks: *"Build me a dashboard of my open opportunities by stage and region, refreshed every morning."*

**Interactive build (Tier 1, sequential, one visible thread):**

| # | Worker | Sees | Can do | Model |
|---|---|---|---|---|
| 0 | **Orchestrator** (the chat turn itself) | Conversation, Personal Context, worker summaries | Decompose task; spawn workers; assemble final response; no MCP tools mounted | Sonnet 4.6 |
| 1 | **Data worker** | Task brief only (no chat history) | `salesforce` MCP only, **read-level tools only**, user's own token, user's attestations; returns a bounded structured dataset + schema summary — raw rows never enter the parent context | Sonnet 4.6 first run; Haiku-tier on repeat/templated pulls |
| 2 | **Build worker** | Task brief + the dataset (nonce-framed as *data, not instructions* — the existing `artifact-context` pattern) | **Zero MCP servers.** Writes the artifact HTML (`workspace_artifacts`) | Sonnet 4.6 |
| 3 | **Verify worker** *(optional)* | The artifact + dataset summary | Read-only consistency check (does every figure trace to the dataset?) — reports pass/fail to orchestrator | Haiku-tier |

Worker 2 having no connector access is the load-bearing security property: prompt-injected content inside Salesforce data reaches a worker that **cannot call any tool** — least privilege by construction, the verified pattern from §1.2. One writer (worker 2) means no parallel-write failure mode exists. All four runs share a `parent_run_id`; each tool call audits as today.

**Where the human sits:** the builder converses with the orchestrator, sees step labels in the activity stream, iterates on the artifact conversationally (existing J4 flow), and personally clicks deploy (existing one-click deploy). Any *write* tool call anywhere in the pipeline (e.g., "also log this review to Salesforce") hits the connector spec's `needs_approval` gate. Sharing follows J5: recipients' own credentials, and the artifact-snapshot caveat from the connector spec (§5 there) still applies unchanged.

**Unattended refresh (Tier 3 = existing J3, not a new build):** the deploy step registers a schedule that re-runs **worker 1 only** with the owner's credentials each morning and writes the fresh dataset into a new `app_versions` entry (data-slot refresh — the template is stable, so no build worker runs). If the pull fails or the returned schema drifts from the recorded one, the run **notifies the owner instead of silently rebuilding** — unattended runs get *less* autonomy, not more. This single composition closes the "dashboards only refresh while the app is open" gap with zero new infrastructure: it's a scheduled Skill whose output target is an app version instead of a thread message.

---

## 4. Open questions / risks

1. **Refresh credentials at 2 a.m.** The scheduled data worker runs on the owner's delegated token with no user present — the token-lifetime open question (overview §10.2) and the connector spec's offline-refresh flag (§6.4 there) must be resolved before shipping the refresh path. Same issue, third spec pointing at it — it's the real blocker.
2. **Latency budget.** Sequential workers serialize cold starts (Anthropic's own anti-subagent argument #4). If a 3-worker build feels slow next to today's single turn, the fallback is honest: keep single-agent for small builds, orchestrate only when a connector fetch is involved. Needs measurement, not speculation.
3. **Bounded worker returns.** "Returns a bounded dataset summary" needs the same deterministic guardrails as `buildTurnContext` (char limits, structured truncation logs) or worker summaries just re-create context bloat one level up.
4. **AgentCore Policy/A2A overlap.** AgentCore now ships its own tool-call Policy interception (Cedar) and multi-agent primitives *(extracted)*. Comparative's ownership rule says governance is the shell's job — but a periodic check that the shell's tool gate and AgentCore's Policy layer aren't drifting into conflict (or duplicate denials) belongs on the runtime-seam owner's list.
5. **Schema-drift refresh semantics.** "Notify, don't rebuild" is the recommended default; some owners will want auto-rebuild. That's a per-dashboard setting decision for the J4 spec, not this one.
6. **Verification residue.** The 8 unverified-by-vote claims are all Tier-3 vendor-doc details (Claude cloud VM specifics, Codex cloud mechanics) — none are load-bearing for the recommendation, which deliberately doesn't adopt any vendor Tier-3 product. The Bun 750k-line-rewrite anecdote and the "~7×" cost figure are single-blog claims and were excluded from the reasoning.
7. **When to revisit Tier 2 / dynamic workflows.** Trigger conditions, not dates: (a) a real GP use case with genuinely independent parallel subtasks at scale (bulk account briefings across hundreds of accounts is the plausible first one), and (b) upstream agent-teams/workflows maturing out of experimental status. Revisit then; the `runs` tree and Skill-shaped workers built for Tier 1 are the correct foundation either way.

---

## 5. Sources (with dates)

**Primary — Anthropic:**
- code.claude.com/docs/en/sub-agents (current at v2.1.211, fetched 2026-07-17) — isolation, tools/disallowedTools, model routing, nesting @ v2.1.172, when-not-to guidance
- code.claude.com/docs/en/agents (current at v2.1.198) — four parallelization approaches; teams lack worktree isolation; worktrees as collision mechanism
- code.claude.com/docs/en/agent-teams (current at v2.1.178–207) — experimental flag, task locking, no nested teams, linear token scaling
- code.claude.com/docs/en/workflows + claude.com/blog/introducing-dynamic-workflows-in-claude-code (2026-05-28) — agent-authored scripts, 16/1,000 caps, Large-workflow warning, disableWorkflows
- code.claude.com/docs/en/changelog (v2.1.169–212) — nesting (2.1.172), Agent(model:…) permission rules (2.1.178), OTel workflow attrs (2.1.202), spawn cap (2.1.212)
- code.claude.com/docs/en/claude-code-on-the-web — VM isolation, credential proxy, rate-limit cost model
- platform.claude.com/docs/en/agent-sdk/subagents — AgentDefinition tools/model, Workflow tool (SDK v0.3.149+)
- anthropic.com/engineering/multi-agent-research-system (2025-06-13) — **4×/15× tokens; 90.2% Opus-lead result; coding-is-a-poor-fit; tracing guidance**

**Primary — other vendors:**
- cognition.com/blog/dont-build-multi-agents (2025-06-12); cognition.com/blog/multi-agents-working (2026-04-22) — single-writer doctrine, read-only subagents, context rot
- developers.openai.com/codex/cloud — async delegation, parallel tasks, summary+diff→PR
- docs.github.com — Copilot coding agent (Actions-powered env, 59-min cap, admin policy, branch protections)
- jules.google/docs — VM isolation, plan-approval checkpoint, experimental
- docs.aws.amazon.com/bedrock-agentcore (post-GA, mid-2026 state) — multi-agent Runtime + A2A, Policy tool-call interception (Cedar), OTel Observability, cross-provider Harness, Registry
- learn.microsoft.com — Azure connected agents (depth-2 cap; deprecated → workflows API, classic retires 2027-03-31); Agent Framework workflows (prerelease, July 2026)

**Secondary/blog (corroboration + practitioner heuristics):** InfoQ dynamic-workflows coverage (2026-06-01); alexop.dev deterministic-orchestration (2026-05-28); buildthisnow.com workflows guide (2026-05-30, upd. 06-14); chatforest.com nested-subagent token math (2026-06-13); hidekazu-konishi.com orchestration guide (2026-06-07); ksred.com (2026-03-16); mindstudio.ai agent-teams (2026-04-11) and workflows-vs-teams (2026-05-31).

### Verification notes

Deep-research run 2026-07-17: 6 angles → 25 sources → 125 claims → top 25 verified with 3 adversarial votes each → **17 confirmed, 0 refuted, 8 unverified** (votes lost to session limits; all eight from primary vendor docs, quoted verbatim, none load-bearing for the recommendation). Synthesis performed by the authoring session from the workflow journal's per-source extractions after the workflow's synthesis agent hit the same session limit. Two stale-web hazards were caught and resolved during synthesis: pre-June-2026 sources still claiming subagent nesting is impossible (superseded by v2.1.172), and a conflicting ~7× cost figure (unsourced; the verified 4×/15× primary numbers were used).
