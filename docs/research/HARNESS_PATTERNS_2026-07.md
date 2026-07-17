# World-class harness patterns — field notes, July 2026

What the strongest harness builders (Anthropic's Claude Code/Agent SDK, OpenAI
Codex, Shopify Sidekick/Roast, Ramp Glass/Inspect) do that Comparative should
learn from, mapped to our roadmap. Compiled from primary docs and engineering
posts 2026-07-17; sources at the bottom of each section.

## The one-line summary

Every serious harness converged on the same four pillars: **a small stable
tool surface with on-demand discovery**, **cache-aligned prompt assembly**,
**evidence-demanding verification loops**, and **evals graded by calibrated
judges over real conversations**. Comparative has the second, is building the
first (#384), and has partial versions of the third and fourth.

## 1. Tool surface: everyone hit our exact wall

- Anthropic states tool-selection accuracy degrades past **30–50 mounted
  tools** — the published threshold behind their Tool Search feature. Their
  guidance: keep the 3–5 hottest tools always mounted, defer the rest behind
  a search tool, namespace tool names by service so one search matches a
  group. MCP-eval accuracy on Opus 4.5 went 79.5% → 88.1% with deferral, and
  multiserver setups shed ~85% of schema tokens.
- Shopify (Sidekick) frames the same cliff qualitatively: 0–20 tools = clear
  boundaries, 20–50 = boundaries blur, 50+ = "multiple paths to the same
  outcome" and death-by-instructions in the system prompt.
- **Bedrock caveat, confirmed**: server-side tool search is InvokeModel-only.
  On the Converse API the pattern must be app-layer — exactly the constraint
  `docs/PROGRESSIVE_TOOL_DISCOVERY_SPEC.md` (#384) designed around. The spec's
  stable-bundle + sticky-activation design is the cache-safe app-layer
  equivalent of `defer_loading`.

**For us:** #384 is validated as the right next platform move; its P1–P4
phases proceed as specced. One refinement worth adopting from Anthropic's
guidance: the discovery tool's results should teach *categories* ("github:
44 tools for repos/PRs/issues") not just names, so one search activates the
right provider in one hop.

- Sources: platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool,
  anthropic.com/engineering/advanced-tool-use,
  shopify.engineering/building-production-ready-agentic-systems

## 2. Just-in-time instructions (Shopify) — the cheapest big win we're not doing

Sidekick moves each tool's usage rules **out of the system prompt** and
returns them **with the tool's output, only when the tool is called**. The
system prompt stays lean and cacheable; guidance is localized to the moment
it matters; instructions can vary by flag or model without touching the
cached prefix. This eliminated their "conflicting guidance" failure mode at
50+ tools with near-zero infrastructure.

**For us:** natural follow-up after #384 P2 — provider bundles keep schemas
lean, JIT instructions keep *guidance* lean. Candidate: fold per-provider
usage rules (GitHub write etiquette, Gmail send gating, artifact nonce
framing) into first-call tool results instead of the preamble.

- Source: shopify.engineering/building-production-ready-agentic-systems

## 3. Cache-aligned assembly + context editing

- Codex re-sends full history statelessly (a ZDR/multi-cloud feature, not a
  bug) and leans entirely on cache alignment: static content first, variable
  last; they document that changing tool availability mid-session busts the
  cache. This is the same discipline #364/#385 established for us and #384
  preserves (bundle changes are sticky, one cache write per activation).
- Anthropic's server-side **context editing** (`clear_tool_uses`, with
  `exclude_tools` to protect load-bearing results and `clear_at_least` to
  amortize the cache invalidation) has replaced client-side compaction as
  their recommended long-session strategy. Codex compacts via a dedicated
  endpoint that returns an encrypted latent-state item, not a text summary.

**For us:** when long-thread cost/latency becomes the next bottleneck,
tool-result clearing with an `exclude_tools` scoping allowlist is the
pattern — not summarize-everything. Bedrock has a native message-compaction
feature worth evaluating first (docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-compaction.html).

- Sources: openai.com/index/unrolling-the-codex-agent-loop,
  platform.claude.com/docs/en/build-with-claude/context-editing

## 4. Verification: evidence, not assertions

- Claude Code's best-practices ladder for gating "done": in-prompt check →
  per-turn goal evaluator → deterministic Stop hook that blocks completion →
  fresh-context second-opinion reviewer ("the agent doing the work isn't the
  one grading it"). Core rule: **demand the check's output** (test results,
  command + exit code, screenshot), because reviewing evidence is cheaper
  than re-running verification.
- Shopify institutionalized it: certainty scores + citations on agent
  output; diffs of human edits vs agent drafts as a free passive quality
  metric (~50% of agent drafts ship unmodified — that number IS the metric).
- Ramp's Inspect gives the agent production parity for verification: it runs
  tests, reads Sentry/Datadog, screenshots frontends — same surface an
  engineer has.

**For us:** our PR gate already embodies the ladder's top rung. The product
gap is #359 (richer work receipts): receipts should carry *evidence* (diffs,
check output, live telemetry), not narration. Shopify's ship-unmodified rate
is a metric Comparative can compute today from artifact revision history.

- Sources: code.claude.com/docs/en/best-practices, builders.ramp.com/post/why-we-built-our-background-agent

## 5. Evals: calibrated judges over real conversations (Shopify)

Ground Truth Sets sampled from **real merchant conversations** (not curated
scenarios), human-labeled with inter-annotator statistics; the LLM judge is
iterated until its agreement (Cohen's κ) approaches the human-human ceiling
(they got κ 0.02 → 0.61 against a 0.69 ceiling). Multiple narrow judges beat
one general judge. Rewards are gated procedurally: cheap deterministic checks
(syntax, schema) must pass before the semantic judge scores — because agents
*will* reward-hack (they observed polite task-declining and hallucinated IDs).

**For us:** this is the missing piece of the model-qual arc (#301–#305). The
qualification gauntlet should grade candidates with narrow judges calibrated
on a small human-labeled set drawn from real Comparative threads, with
deterministic gates (tool-call validity, scoping) before any judged score.

- Source: shopify.engineering/building-production-ready-agentic-systems

## 6. Adoption mechanics (Ramp Glass) — the product playbook

- **Zero-config connectors**: Okta SSO auto-wires every enterprise tool at
  first login. The harness bottleneck was never the model — it was setup
  friction ("everyone figuring out MCP configs alone").
- **Org-graph memory**: Glass builds per-user memory from authenticated
  connections (collaborators, active tickets, relevant threads) with a
  **24-hour batch synthesis pipeline** over past sessions — not per-message
  RAG.
- **Skill marketplace + recommender**: 350+ user-built skills; "Sensei"
  recommends the 5 most relevant from role + connected tools + current work.
  Goal: anyone can use AI as well as the best person did, once.
- **No-mandate virality**: public multiplayer workspaces with per-user
  attribution; >50% of merged PRs agent-assisted with zero mandate.

**For us:** validates the role + org-graph direction for "recommended for
your role" (reco engine), and #78 (opt-in shared AI work cards) is exactly
the multiplayer-visibility lever Ramp used. Scheduled natural-language
automations ("every morning, summarize X to Slack") are their adoption
workhorse — worth a roadmap slot.

- Sources: builders.ramp.com/post/why-we-built-our-background-agent,
  modal.com/blog/how-ramp-built-a-full-context-background-coding-agent-on-modal,
  fintechbrainfood.com/p/ramp-cracked-ai

## 7. Sandbox posture (Codex) — for when Comparative executes code

Codex's model: sandbox-by-default (Seatbelt/bubblewrap), three modes
(read-only / workspace-write / full), network off by default, and — the
important part — **blocked commands trigger an approval request with a
justification instead of failing**. The harness tells the model what its
cage looks like (a developer-role message describing the sandbox), so the
model escalates rather than flails. Their AGENTS.md layering (global → repo
→ nested dirs, closer wins, 32 KiB cap) is the instruction-file pattern.

**For us:** parked until Comparative runs arbitrary code; the
"describe-the-cage" principle already applies to our preamble honesty work —
the model should always know what's mounted vs discoverable (#384 P2).

## Priority read on our backlog (2026-07-17)

1. **#384 P1–P4** — the tool-surface pillar; in flight.
2. **JIT tool instructions** — file as follow-up to #384 P2; cheap, big.
3. **#359 receipts-with-evidence** — the verification pillar, product-side.
4. **Judge calibration for #301** — Ground-Truth-Set method, small and real.
5. **#78 + scheduled automations** — the adoption pillar, after platform
   work stabilizes.
