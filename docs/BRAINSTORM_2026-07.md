# Harness Expansion Brainstorm — July 2026

Cofounder-style review of where Comparative is and where to take it next.
Synthesized from a full read of the codebase, docs/ADRs/specs, all 95 closed +
3 open issues, and the June PR history. The committed direction at the bottom
is groomed into issues #291–#295, with epic children broken out as #296–#305.

Long-horizon companion: [`docs/STRETCH_GOALS_2026-07.md`](STRETCH_GOALS_2026-07.md)
— the seven wow-factor bets this 90-day plan is the foundation for.

## The thesis

**"Cursor for knowledge work."** Own three layers permanently — the **harness**
(runtime, routing, evals, governance), the **context** (user/project/team/org
knowledge, memory, artifacts), and the **data-connection layer** (MCP/Gateway,
credentials, attestation) — and treat **models as substitutable inputs** chosen
per task by capability, cost, and availability.

Cursor's lesson: the model picker is table stakes; the moat is everything
wrapped around it (repo index, apply model, agent harness) that makes any model
good and makes switching free. Comparative's equivalents already exist in
embryo: the context pack, the capability graph, the three-lane router, per-user
credential scoping, and — the underrated one — the **eval gauntlet**, which is
what makes model substitution *safe* rather than reckless. What's missing: the
model layer itself is mono-vendor today (three Claude tiers via Bedrock).

## Where we are

The capability funnel — **Chat → Skill → Scheduled Agent → App → Share** — is
structurally real: every stage has tables, APIs, and at least a thin shipped
slice. J1 chat is mature; GitHub and Notion are the two live integrations;
governance (attestation, audit, per-user credential scoping) and the honesty
eval gauntlet are genuine moats. Open epics: #27 (scheduled agents — delivery +
triggers), #133 (app lifecycle next phase), #78 (share cards). The active
platform bet is AgentCore Gateway as the integration layer (#279 spike runbook
done, awaiting execution). SES production access is approved; invite email
verification is tracked in #291.

## Strategic frame

Two throttles govern everything:

1. **Real usage.** Nothing in the vision (share cards, Agent Wire,
   recommendations) compounds without users generating work.
2. **Integration breadth.** Every flagship use case (Meeting Prep, Weekly
   Status, Account Briefing, Data Exploration) is blocked on M365 / Salesforce /
   Databricks / Workfront.

The moat is already built (governance + honesty + AWS-native trust). The gap is
**demand-side**: things that make a knowledge worker open Comparative instead
of ChatGPT every morning.

## Opportunity map

### Horizon 1 — Now (unblock + compound what exists)

1. **Verify invite email end-to-end** (#291) — SES prod approved; Codex
   verifies via AWS CLI, refreshes PR #272, Rob merges. Highest
   leverage-per-hour in the backlog.
2. **Finish J3: proactive delivery** (#292) — notification center + daily
   digest. Runs complete today but results sit in threads nobody reopens.
   "Work is waiting for you" is the biggest perceived-value jump available.
3. **Event triggers** (#293) — GitHub webhooks → runs ("when my PR gets a
   review, brief me"). Runs ledger + worker lane already support it.
4. **Web search tool** — the one consumer capability everyone expects
   (per DESKTOP_PARITY_BACKLOG). Extends the SSRF-hardened, nonce-framed
   `web__fetch_url` pattern. Not yet filed.

### Horizon 1.5 — The model-agnostic substrate (#295)

- **Multi-model registry + eval-gated onboarding**: qualify models like
  vendors — golden transcripts + faithfulness evals + latency/cost benchmarks
  → scorecard → admin enables per lane. Non-frontier models failing agentic
  evals and landing in cheap lanes (summaries, titles, routing, memory
  capture) is the feature, not the bug.
- **Capability/cost-aware routing within lanes**, with cross-model failover
  (seeds: #105 fallback work, #243 provenance).
- **Portable context pack**: keep skills/preambles provider-neutral so a model
  swap is config, not a rewrite; enforce via an eval now, not a retrofit later.

### Horizon 2 — Next (the integration factory + app loop)

- **Integration factory via AgentCore Gateway** (#294, children #296–#299):
  execute the Salesforce spike, converge on Gateway as the one integration
  pattern (spec + credential provider + catalog rows = a new integration),
  then ship **Gmail + Google Calendar** first — all alpha testers are on
  Gmail, and mail + calendar unlock Meeting Prep and Weekly Status, both
  feeding the delivery loop. M365 Graph is the enterprise follow-on on the
  same pattern once Comparative runs in an enterprise box.
- **J4 conversational build-iterate loop** (#133 phase 2) — the roadmap's own
  "biggest value unlock"; data model shipped, iteration UX is the multiplier.
- **Projects/workspaces + user-facing memory surface** — the KM ADR designs
  the scopes; Vault works but is invisible. Projects make repeated work
  compound and are the prerequisite for team context.

### Horizon 3 — Later (org-level compounding)

- **Team/org entity + share cards** (#78) — no team table exists yet; needed
  for team shares, the discovery feed, and role-based recommendations.
  Sequence after real usage exists.
- **Agent Wire lite** — skip the S3/Athena build; `runs` + `audit_log` already
  hold the org-learning signal. An admin "what's working" dashboard produces
  the adoption story for leadership cheaply.
- **Skills 2.0 — reliability before power** — per-skill run health from the
  runs ledger first (history: #144, #234, #246, #247); then parameterization
  (the reserved `paramsSchema`), then composition.

## Watch-outs

- **Artifact revision semantics are the #1 repeat offender** (five bugs, four
  PRs on the same surface in June: #242/#244/#256/#276/#284). Projects and J4
  both build on artifacts — budget a consolidation pass first.
- **Avoid three runtime stories.** Adopt AgentCore Harness behind the
  `agent-runtime` seam per the migration packet's shadow-cutover plan; stop
  investing in the custom AgentCore container lane and unshipped Runtime V2
  autopilot parts. Nothing AgentCore-specific may serialize into skills,
  apps, or context.
- **Artifact/file content lives in Postgres text columns** — move to S3 before
  Projects make files heavy.
- **Keep one enterprise-gate slot per cycle** (PingOne SSO → threat model →
  private subnets → shared quota store) so the IT review is never the long
  pole.
- **Tenant-shape three things when touched** (teams/org entity, artifact
  storage, quota store) — build for the current org, don't pour concrete
  against a market-sized future.

## Committed direction

North-star metric: **accepted proactive work per user per week** — scheduled or
triggered runs whose output the user opens and acts on (Cursor's
"accepted tabs" equivalent).

90-day sequence:

| When | What | Issues |
| --- | --- | --- |
| Week 0 | Verify SES invite email via AWS CLI (Codex), land PR #272, get to ~15 weekly users | #291 |
| Weeks 1–4 | Proactive delivery loop: notification center + digest, then email delivery, then GitHub event triggers | #292, #293 |
| Weeks 3–8 | Integration factory: execute Gateway spike, converge pattern (ADR), ship Gmail + Google Calendar, Meeting Prep / Weekly Status flagship skills | #294 → #296–#299 (+#279) |
| Weeks 6–12 | Model qualification substrate: registry, scorecard pipeline, admin page, routing, first non-Anthropic models on cheap lanes | #295 → #300–#305 |
| Continuous | One enterprise-gate item per cycle; artifact-revision consolidation before J4 phase 2; J4 iterate loop once weekly usage is real | #133 |
