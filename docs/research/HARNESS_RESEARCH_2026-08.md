# Harness & UX research wave — August 2026

> Three-workstream research pass (2026-08-11): a full UI/UX review of
> `apps/web`, a delta teardown of Omnigent since the 2026-08-09 review, and a
> cross-harness best-practices sweep (Claude Code, Codex, Buzz, Hermes, pi,
> et al.). Successor to [`HARNESS_PATTERNS_2026-07.md`](./HARNESS_PATTERNS_2026-07.md),
> the Codex research (#440 → #436–#439), and the Omnigent review that produced
> Contribution Studio (#735) and Governed Custom Agents (#736). This wave was
> explicitly scoped to the **delta** beyond all of those.
>
> **Tracking:** UI/UX epic [#762](https://github.com/DadJokez/AI-workspace/issues/762)
> (children #763–#769) · Harness adoption wave 2 epic
> [#770](https://github.com/DadJokez/AI-workspace/issues/770) (children #771–#780).

## Assumptions made (flagging per working agreement)

1. **"Omnigent from Databricks" = `omnigent-ai/omnigent`.** Confirmed correct:
   announced on the Databricks blog and @databricks X account, code under a
   deliberately vendor-neutral org (the MosaicML/MLflow playbook), monetized as
   "Omnigent on Databricks (beta)". Apache 2.0, self-declared alpha, ~8.5k
   stars, weekly releases since 2026-06-13.
2. **"buzz" = Buzz by Block** (Jack Dorsey's company; launched 2026-07-21,
   Apache 2.0) — "Slack for humans and coding agents" on Nostr identity.
   **"Hermes" = Hermes Agent by Nous Research** (Feb 2026, MIT).
   **"pi" = pi by Mario Zechner/badlogic** (now Earendil, pi.dev). All three
   verified via search; no other credible candidates surfaced.
3. **Issue granularity:** grouped ~21 UI findings into 7 issues and ~20 harness
   recommendations into 10, rather than one issue each — matched to how the
   backlog is already organized (epics with meaty children).
4. **Placement:** findings logged as repo issues + this doc (not gists), since
   the repo already has a `docs/research/` convention and the backlog is
   GitHub-issue-driven.
5. **Non-adoptions were decided, not deferred** — recorded below so they don't
   get re-litigated by the next research pass.
6. Some primary vendor domains (anthropic.com, databricks.com, pi.dev) were
   blocked by the session's egress proxy; those specific claims rest on search
   metadata and secondary coverage, marked in the source lists.

## 1. State snapshot (as of `main` @ 85196cc, 2026-08-11)

- **Shipped:** all five journeys have surface. J1 mature; J2 live with
  GitHub/Gmail/Calendar/Notion; J3 schedules + GitHub event triggers; J4 thin
  apps with versions/revert; J5 named shares. Bedrock interactive + AgentCore
  durable lanes on ECS/Fargate.
- **In flight:** Contribution Studio epic #735 — first slices merged in the
  last two weeks (#750 queued follow-ups, #751 Context Shelf, #752 shell,
  #753 conformance contracts, #754 Studio launcher palette, #761 artifact
  review modes); open tracks #739, #741, #743, #744, #756. Governed Custom
  Agents epic #736 (#745–#748) not yet started. No open PRs at review time.
- **Backlog spine:** hardening #453, identity #491, perimeter #492,
  accountable runtime #493, habit loop #494, capability flywheel #495, model
  qualification #295. Live quality flags: nightly evals failing #733, flaky
  Playwright queue test #759.

## 2. Workstream 1 — UI/UX review of `apps/web`

Full findings live in epic **#762** and children **#763–#769**, each with
file:line evidence. The shape of the result:

**Strengths to protect** (do not churn): Umber token discipline with
flash-free dark-mode init; the work-receipt stack with honest live footers and
truthful cost tooltips (the product's trust spine); SettingsModal focus
management; CommandPalette combobox ARIA; reduced-motion handling; the
Follow-ups queue with honest steering copy; login anti-oracle sent-state;
composer draft persistence.

**The five highest-leverage changes:**

1. **#763 (P1):** the composer disables forever with "Loading models…" if
   `/api/models` fails once at load — no error, no retry. Worst degraded state
   in the app; trivially fixable.
2. **#765:** three different app shells — Skills/Apps/Admin eject users from
   the sidebar workspace frame entirely. Enterprise legibility comes from a
   stable frame.
3. **#764:** errors don't look like errors. Danger tokens exist but failure
   states render in muted/neutral styles; several sidebar failures are
   swallowed with no surface at all; there is no toast primitive in the
   codebase.
4. **#766:** raw Bedrock model IDs, UTC ISO timestamps, and machine status
   strings leak into the Skills surface; catalog copy says "(soon) schedule
   and share" for features that shipped — a literal honesty bug given the
   product rubric.
5. **#767:** the "/" palette and "@" Context Shelf — the two features that make
   this more than a chatbot — are invisible: the advertising placeholder is
   always overridden and the @ button is a bare glyph.

Also filed: accessibility wave (#768 — the welcome tour has an invisible
full-screen button in the tab order and no focus trap; the *first* thing every
new user meets), and design-system consolidation (#769 — five competing
"primary" button recipes).

## 3. Workstream 2 — Omnigent delta (beyond the 2026-08-09 review)

The prior review (commit `c2167000`) mined the interaction layer into #735 and
#736. This pass covered what it didn't: the policy engine, sandbox/credential
model, observability, session collaboration, and everything shipped after
Aug 9.

**Ships-by-Databricks confirmed** (see assumption 1). Release cadence is
weekly; the Aug 10–11 commit log is dominated by per-harness stabilization
fixes — direct evidence of the maintenance tax of the meta-harness strategy,
and a reinforcement of our decision not to become one.

**Top findings, ranked by value on top of #735/#736 (all now tracked):**

1. **Stateful policy engine** (`docs/POLICIES.md`): ALLOW/DENY/ASK with three
   scopes, runtime REST CRUD, and a discoverable policy registry with JSON
   schemas (admin UI nearly free). Cost policies include per-user daily
   budgets that remember soft-threshold approvals, **downgrade gates** (hard
   limit denies only while on an expensive model — work continues on a cheap
   one), trivial-prompt gating off expensive models, session risk scoring, and
   `detect_loop`/`detect_thrashing` watchdogs. → **#775**, riding the #410
   engine and feeding #436/#734.
2. **Credential proxy + declarative egress rules**: sandboxed tools
   authenticate via an egress proxy that injects tokens on approved requests —
   secrets never enter model context or the sandbox. v0.8.0 also stopped
   agent CLIs inheriting host credentials by default. → **#776**, the
   enforcement half of #439.
3. **OTel GenAI semantic-convention tracing** with message-body capture off by
   default (explicit consent-flagged opt-in), traces stored under existing
   governance (MLflow/Unity Catalog ≈ our CloudWatch/AgentCore). → **#777**.
4. **Delegated approval authority** (v0.8.0): run owners grant named
   collaborators the right to answer approval prompts, with attribution —
   the on-call/vacation pattern for shared long-running work. → folded into
   **#773**.
5. **Scheduler ergonomics** (v0.7.0): Run-now, per-task model/effort
   overrides, run-history API. → **#780**.

**Where we're ahead — nothing to copy:** evals (Omnigent has only a
conformance bench + a roadmap pointer at Mosaic AI Agent Evaluation; our
eval-gated publishing plan is stronger) and memory (optional third-party
Hindsight integration vs. our Vault + #413 scopes).

**Noted but not adopted:** the multi-harness abstraction itself (Omnigent's
core product, our anti-goal); named persistent PTY terminals (only relevant if
we add code-execution workspaces); the sandbox-provider SPI (we're
Bedrock-committed; revisit only if a second execution backend ever matters);
embedded desktop browser; iOS/desktop shells. Conversation search (pg_trgm)
and projects/folders were noted toward the #494 habit-loop epic rather than
duplicated.

## 4. Workstream 3 — cross-harness best practices

Per-harness sketches (full citations in the epic and below):

- **Claude Code**: subagents as context isolation; SKILL.md progressive
  disclosure; deterministic lifecycle hooks (`PreToolUse` as the security
  checkpoint); checkpoints + `/rewind` restoring files *and* conversation;
  plan mode; hierarchical CLAUDE.md; experimental multi-instance Agent Teams.
- **Codex**: sandbox modes × approval policies enforced at OS level (Seatbelt/
  Landlock); **two-phase cloud runtime** — setup gets internet + secrets, the
  agent phase gets neither; PR-native output.
- **Buzz (Block)**: humans and agents as peers in one workspace behind signed
  Nostr identities — every message/review/git event is a signed event in one
  log (audit by construction); harness-agnostic via ACP; agent teams with a QC
  agent reviewing the others.
- **Hermes (Nous)**: **agent-authored, self-improving skills** (agentskills.io
  standard); procedural memory with FTS session search + user modeling;
  pluggable terminal backends; multi-channel gateway; built-in cron.
- **pi (badlogic/Earendil)**: radical minimalism — four tools, tiny prompt,
  TypeScript extensions for everything else; tree-structured sessions;
  embeddable core (RPC/SDK) that Earendil built a cloud on. The
  counter-argument to feature accretion: a small legible harness + a good
  model goes far.
- **Also swept:** Gemini CLI (checkpoint `/restore`), Amp (Oracle reviewer
  model, parallel-by-default tools, multi-model routing), OpenHands (RBAC/
  SSO/audit reference), Aider (every change is a git commit), Devin
  (playbooks/knowledge), LangGraph (**durable `interrupt()`** that persists
  across restarts and waits indefinitely).

**Convergence points across the field:** context as a budgeted resource with
graduated editing (tool-result clearing → compaction with structured
carry-over); skills as files with progressive disclosure; deterministic policy
outside the model; subagents for context isolation more than parallelism;
verification loops with independent reviewers; checkpoint/rewind as table
stakes; durable human-in-the-loop; OTel GenAI conventions for observability;
model/harness decoupling.

**Adoption ranking → issues:** #771 context lifecycle (rank 1 — the enabling
layer for durable/scheduled runs), #772 checkpoints & rewind (rank 2 — the
trust lever), #773 durable approvals, #774 independent verifier pass, #775
policy engine, #776 credential proxy, #777 OTel tracing, #778 progress notes +
recall, #779 save-as-skill, #780 quick wins (parallel tool calls, schedule
Run-now/model override).

**Considered, not filed (revisit later):**

- **Sandboxed code interpreter for knowledge work** (AgentCore Code
  Interpreter + Codex-style profiles and phase-split secrets). High value,
  but it deserves its own spec after the J4 deploy-controller shape firms up.
- **Browser/computer-use runs** for no-API systems: weakest security story
  (prompt injection via web content); pilot only behind admin allowlists, and
  #756 (Studio browser) should land first.
- **Model routing / multi-model registry**: already owned by #295 and
  `MODEL_DECIDED_ROUTING_SPEC.md`; the research adds only confirmation.
- **Golden-transcript regression evals**: largely covered by the existing eval
  program (`CORE_EVAL_PROGRAM.md`, `REGRESSION_GAUNTLET.md`, nightly evals);
  the gap is fixing #733, not new machinery.

## 5. How this wave relates to prior research

| Prior work | This wave's relationship |
|---|---|
| `HARNESS_PATTERNS_2026-07.md` (tool surface, cache, verification, judge evals) | Extends: run-lifecycle + enforcement pillars; no overlap re-filed |
| #440 Codex research → #436–#439 | #775 feeds #436; #776 is the enforcement half of #439 |
| Omnigent review 2026-08-09 → #735/#736 | This pass covered only unmined systems + the post-`c2167000` delta |
| specs/memory-context, multi-agent-orchestration | #771/#778 are inputs to those specs, not parallel systems |

## 6. Sources

Omnigent: [repo](https://github.com/omnigent-ai/omnigent) ·
[POLICIES.md](https://github.com/omnigent-ai/omnigent/blob/main/docs/POLICIES.md) ·
[AGENT_YAML_SPEC.md](https://github.com/omnigent-ai/omnigent/blob/main/docs/AGENT_YAML_SPEC.md) ·
[databricks.md](https://github.com/omnigent-ai/omnigent/blob/main/docs/databricks.md) ·
[sandbox_providers.md](https://github.com/omnigent-ai/omnigent/blob/main/docs/extending/sandbox_providers.md) ·
[releases](https://github.com/omnigent-ai/omnigent/releases) ·
[Databricks announcement (blocked; via search metadata)](https://www.databricks.com/blog/introducing-omnigent-meta-harness-combine-control-and-share-your-agents).

Harness sweep: [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams) ·
[Claude Code feature reference](https://hidekazu-konishi.com/entry/claude_code_features_settings_reference_2026.html) ·
[Codex sandbox docs](https://github.com/openai/codex/blob/main/docs/sandbox.md) ·
[Buzz](https://github.com/block/buzz) ·
[Hermes Agent](https://github.com/NousResearch/hermes-agent) ·
[pi-mono](https://github.com/badlogic/pi-mono) ·
[Gemini CLI](https://github.com/google-gemini/gemini-cli) ·
[Amp manual](https://ampcode.com/manual) ·
[LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) ·
[Anthropic context engineering (blocked; via search metadata)](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) ·
[Anthropic long-running harnesses (blocked; via search metadata)](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) ·
[OTel GenAI status](https://greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions).
