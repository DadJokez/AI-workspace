# ADR 0006 - Sonnet 4.6 decides when interactive chat needs tools

- **Status:** Accepted
- **Date:** 2026-07-11
- **Deciders:** Rob, Comparative engineering
- **Related:** [ADR 0003](./0003-aws-only-runtime-substrate.md), [ADR 0004](./0004-agentcore-gateway-integration-pattern.md), [GitHub issue #364](https://github.com/DadJokez/AI-workspace/issues/364)

## Context

Comparative should feel like one capable assistant. A user should not need to
select a mode, name a connector, or phrase a request with a routing keyword.
The prior interactive path used regex intent matching to decide whether the
model could see account tools, web search, or neither. That kept simple turns
cheap, but it also hid capabilities before the model could reason about the
request. Every new phrasing or connector behavior risked another routing rule.

The alternative must preserve fast streaming, enterprise authorization, and
the separate AgentCore lane for genuinely durable work. It must also avoid
adding a second classifier call before the answer, because that extra round
trip would work against the product's latency goal.

A live benchmark exercised the same stable 38-tool catalog used by the app.
With warm Bedrock prompt caching, Sonnet 4.6 produced first text at a 991 ms
median and completed at a 1,473 ms median, with a 97% cache-read ratio. The
median first-text cost versus tool-less Haiku was about 137 ms, or 1.20x.
Sonnet selected no tool for ordinary conversation and selected the correct
provider for current-information and calendar requests.

A nine-case behavioral suite then covered conversation, ambiguous requests,
web, Gmail, GitHub, Calendar, multi-turn follow-up, and a disconnected-tool
case. The first run caught an over-eager Calendar call for a question about the
assistant's own plans. A general tool-ownership rule fixed that failure, and
two consecutive runs passed 9/9. The final telemetry-aware run cost an
estimated $0.0719 at standard Bedrock rates.

## Decision

Use one standard Sonnet 4.6 interactive lane and let the model decide whether
to call a tool.

- Every ordinary interactive turn mounts the stable catalog of tools the user
  is currently authorized to use. Tool visibility remains an application
  authorization decision; the model cannot grant itself access.
- Configured built-in tools, including web search, are mounted without
  keyword-based intent gating.
- The catalog and schemas use deterministic ordering so Bedrock prompt caching
  can reuse the stable prefix.
- The preamble describes tool purpose, user-data ownership, disconnected-tool
  behavior, and the expectation that no tool is needed for normal
  conversation. It must not encode brittle examples for individual phrases.
- The same model call streams the answer and performs any tool loop. There is
  no preliminary classifier request.
- Durable routing remains separate. AgentCore selection continues to depend on
  task durability and execution requirements, not on whether an interactive
  turn happens to need an MCP tool.
- Persist the routing mode, model-selection reason, provider/tool receipts,
  timing, cache-token counts, and safe cost estimates for evaluation and
  operations.
- Keep `ROUTING_MODE=regex` as a temporary rollback setting while
  `model-decided` is proven in production. Missing or invalid configuration
  fails closed to the regex path.
- Explicit one-turn model overrides remain available for controlled testing;
  the production default is Sonnet 4.6. Sonnet 5 is deferred until AWS model
  access is available and separately evaluated.

## Consequences

**Positive**

- Users can ask naturally; tool and connector use no longer depends on a
  growing phrase list.
- Simple chat keeps a single streaming model round trip.
- Connected tools are consistently available to the model while existing
  OAuth, catalog, attestation, confirmation, and audit controls stay in force.
- Deterministic catalogs and prompt caching keep the broader capability set
  within the measured latency and cost envelope.
- Behavioral regressions can be evaluated semantically rather than by testing
  implementation-specific regex matches.

**Negative / risks**

- Sonnet 4.6 costs more than Haiku and can still over-call a tool when a prompt
  is ambiguous.
- A larger tool catalog increases schema tokens and may eventually reduce tool
  selection quality despite caching.
- Model behavior is probabilistic. Production telemetry and repeatable evals
  become required release controls, not optional diagnostics.
- The rollback path temporarily leaves two routing behaviors to maintain and
  test.

## Alternatives considered

- **Keep regex gating and expand the phrase list.** Rejected because it hides
  authorized capabilities before model reasoning and requires product code for
  ordinary language variation.
- **Use Haiku as a classifier before Sonnet.** Rejected because it adds latency,
  duplicates intent reasoning, and creates a new failure boundary before the
  answer can stream.
- **Use Haiku with the full catalog for all turns.** Rejected because the
  benchmark showed similar total latency but weaker reasoning headroom for
  writing, ambiguity, and cross-tool requests.
- **Train or host a dedicated intent router.** Deferred until measured scale,
  cost, or reliability demonstrates that a separate routing model beats the
  single-call architecture.
- **Wait for Sonnet 5.** Rejected for this rollout because current AWS account
  access is not available. The architecture is model-portable and does not
  require that delay.

## Revisit when

- The authorized catalog grows beyond roughly 50 tools or tool-choice accuracy
  drops as providers are added.
- Warm first-text latency, cache-read ratio, tool over-call rate, or per-turn
  cost exceeds the production budget for a sustained period.
- Sonnet 5 or another Bedrock model becomes available and beats Sonnet 4.6 on
  the checked-in routing suite without unacceptable latency or cost.
- Durable and interactive routing requirements converge enough that keeping
  their decisions separate creates user-visible inconsistency.
- Production confidence is high enough to remove the regex rollback path and
  its tests.
