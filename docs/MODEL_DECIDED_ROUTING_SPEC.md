# Model-Decided Routing Spec

**Issue:** #364 · **Related:** #303 (model selection within lanes), #313 (web-search
self-hiding), PR #363 (tactical regex patch this replaces)
**Status:** Proposed — Phase 2 benchmark is the go/no-go checkpoint
**Owner:** Rob (merges, pricing sign-off) · Codex/Claude (implementation via the PR gate)

## Problem

Chat lane selection is regex-based (`hasToolIntent` → `hasWebSearchIntent`,
`CONNECTED_RESOURCE_RE` in `apps/web/lib/chat-routing.ts`). Two production
failures in one week showed both failure modes:

1. **Recall:** "who won the england norway game?" matched no keyword → tool-less
   fast lane → the assistant denied a capability it has. This is an honesty
   regression, the product's spine.
2. **Precision:** the #363 review immediately caught the widened regexes
   hijacking "score this essay" and "what are you doing this weekend?" onto the
   web lane. Every regex edit is whack-a-mole in both directions.

There is also a quieter cost: lane flapping changes the mounted tool set per
turn, and Bedrock's cache hierarchy (tools → system → messages) means any
tool-set change evicts the whole downstream cache.

## Decision

Move the "does this turn need tools?" decision from regexes to the model.
Single-lane architecture on Sonnet 5:

- **One chat lane.** Every chat turn runs with the user's **stable tool set**
  mounted: their approved/connected provider facades (Google, Notion,
  Salesforce, GitHub) plus builtin `web_fetch`/`web_search` when configured.
  The model decides when to call tools — the same architecture as Claude Code.
- **Sonnet 5 (`us.anthropic.claude-sonnet-5`) becomes the default chat model.**
  Verified available in account 351478076796 / us-east-1 (model + us. inference
  profile, checked 2026-07-11). Haiku 4.5 stays in the registry as a
  user-selectable economy option, not an auto-routed lane. The current
  Haiku/Sonnet auto-*model* selection in `runtime-model-policy.ts` is separate
  from capability-lane routing and remains in #303's scope.
- **The stable tool set is cached.** `packages/agent/src/clients.ts` already
  writes Converse `cachePoint`s after tools and after the system prompt; the
  win requires the tool set to be stable within a conversation, which this
  design guarantees (it changes only when the user connects/disconnects a
  provider).
- **Intent regexes retire** behind a flag (see Phases). Provider precedence
  ("calendar today" → Google, not web) moves into tool descriptions, where the
  model weighs it — the reason `CONNECTED_RESOURCE_RE` exists today.
- **`durable-local` routing is unchanged.** That lane is about execution
  substrate (long-running jobs), not capability gating.

## Why

Deep-research findings (103-agent verified run, 2026-07-11; full citations in
#364):

- No surveyed leading harness (Claude Code, Codex CLI, ChatGPT, Cursor,
  Perplexity, Harvey, Glean, Devin, Windsurf) shows evidence of regex tool
  gating. ChatGPT routes with a continuously **trained** router; Anthropic
  harnesses mount tools and let the model decide.
- Model tool selection degrades above ~30–50 mounted tools. Comparative's full
  catalog is ~28–38 across ALL providers (Google 8, Notion 14, Salesforce 4,
  builtins 2, GitHub) and per-user sets are smaller — safely under the knee, so
  "mount everything, model decides" is reliable at our scale.
- Bedrock cache reads price at 0.1× input; AWS quotes up to 90% cost / 85%
  TTFT reduction on the cached prefix. A stable mounted tool set costs ~10% of
  list after the first turn of a conversation.
- Deferred tool search (the >50-tools pattern) is InvokeModel-only on Bedrock;
  we use `ConverseStreamCommand`. Explicitly not needed and not usable — a
  future concern if the catalog triples.
- Cost reality: Bedrock is ~1.7% of the AWS bill. The Haiku fast lane optimizes
  pennies while causing trust bugs in the product whose pitch is trust.

## Non-goals

- No trained classifier router (RouteLLM-style) — overkill at this scale.
- No deferred tool loading / tool search.
- No change to #313 semantics: unconfigured web search still never mounts and
  is never listed, so capability honesty holds in both states.
- No change to durable-lane detection or to #303 (which composes with this:
  this spec decides the lane; #303 decides the serving model within it).

## Phases (each is one PR through the CI + Claude-verdict gate)

**P1 — Register Sonnet 5.** Add `sonnet-5` to `packages/agent/src/models.ts`
(MODEL_IDS, MODELS metadata, Bedrock ID `us.anthropic.claude-sonnet-5`) and the
alias map in `apps/web/lib/runtime-model-policy.ts`. Gate: Rob verifies the
Bedrock rate card for Sonnet 5 before it becomes selectable (us.* profile has
historically been list + 10% — verify, don't assume).

**P2 — Benchmark (go/no-go).** Script in `packages/evals` measuring TTFT and
per-turn cost on Bedrock across: (a) Haiku 4.5 tool-less (today's fast lane),
(b) Sonnet 5 with cached full tool set, (c) Haiku 4.5 with cached full tool
set. Prompt mix: chit-chat, natural current-info questions, provider questions.
Before running the comparison, widen the Bedrock and agent `usage` events to
preserve `cacheReadInputTokens` and `cacheWriteInputTokens` separately from
ordinary input tokens, then carry those values into the existing run telemetry.
Today `clients.ts` folds all three values into `tokensIn`, so current logs cannot
prove a cache hit or calculate a cache-read ratio. The benchmark records cold
and warm TTFT, cache-read/write tokens, output tokens, and estimated cost; post
the results table to #364. Sonnet 5 and Haiku 4.5 both require a 4,096-token
minimum per cache checkpoint, so the benchmark must verify that the actual
tools + system prefix clears that threshold and produces cache reads.
*Checkpoint:* if (b) p50 TTFT is acceptable for chit-chat (target: within
~1.5× of (a) or under ~1s), proceed single-lane. If not, fall back to the
escalation-hatch variant (appendix) — decision recorded in #364.

**P3 — `ROUTING_MODE=model-decided` flag.** Behind the flag: chat turns build
the stable per-user tool set (approved capabilities + configured builtins) and
skip `hasToolIntent`/`hasWebSearchIntent`; sticky-lane logic simplifies to
"durable or not". Default remains `regex` until P4 passes.

**P4 — Eval conversion.** The routing unit tests become behavioral evals in
`packages/evals`: assert the model *calls* `web__search` for "who won the
england norway game?", calls Google (not web) for "what's on my calendar
today?", and calls nothing for "how are you?". Run in nightly evals (token
cost); CI keeps pure contract tests. Acceptance: eval pass rate ≥ the regex
baseline on positives, zero honesty regressions on the regression gauntlet.

**P5 — Flip and delete.** Default `model-decided`, one release of soak, then
delete the regex intent functions (rubric: no dead code). Keep the flag one
release as break-glass.

## Acceptance criteria

- Natural current-info questions reach web search with zero routing keywords.
- Provider questions ("calendar today", "email this morning") call their
  provider tools, not web — asserted by evals, not regexes.
- Chit-chat produces no tool calls and no meaningful latency regression
  (benchmark budget from P2).
- The assistant never denies a mounted capability (honesty eval).
- Cache-read and cache-write tokens remain distinct in run telemetry, making
  the multi-turn cache-read ratio directly measurable and showing whether the
  stable-prefix design is working.
- Data scoping unchanged: the tool set is built exclusively from the
  requesting user's grants (existing per-user OAuth pattern).

## Risks

- **Sonnet 5 pricing unverified** → P1 gate; Rob signs off the rate card.
- **Tool over-calling on chit-chat** (model searches the web for "hi") →
  P4 evals gate the flip; tool descriptions carry "only when needed" guidance.
- **Latency regression** → P2 checkpoint before any user-facing change; flag
  rollback after.
- **Cache minimum** is 4,096 tokens per checkpoint for both Sonnet 5 and Haiku
  4.5. The full harness prefix is expected to clear it, but P2 measures rather
  than assumes that; Haiku still matters in the hatch fallback.

## Appendix — fallback variant: escalation hatch

If P2 shows Sonnet 5 chit-chat latency is unacceptable, keep two **stable**
lanes: the fast lane runs Haiku with exactly one tool, `escalate_to_tools`
("call this when the request needs live data, web lookup, or a connected
tool"). On call, the turn re-runs on the tool lane. The routing decision is
still the model's reasoning — no keywords — and both lane configs are stable,
so each keeps its own prompt cache. Costs one extra Haiku round-trip only on
escalated turns.
