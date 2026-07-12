# Model-Decided Routing Spec

**Issue:** #364 | **Related:** #303 (future model optimization), #313
(web-search self-hiding), PR #363 (tactical regex patch this replaces)
**Status:** Approved - Sonnet 4.6 benchmark passed; implementation in progress
**Owner:** Rob (product and merge approval) | Codex/Claude (implementation through
the PR gate)

## Problem

Chat capability routing is regex-based (`hasToolIntent`,
`hasCapabilityBackedToolIntent`, `hasWebSearchIntent`, and provider-specific
helpers in `apps/web/lib/chat-routing.ts`). Two production failures in one week
showed both failure modes:

1. **Recall:** "who won the england norway game?" matched no keyword, entered
   the tool-less lane, and denied a capability the product had.
2. **Precision:** widened regexes then sent "score this essay" and "what are you
   doing this weekend?" to web search. Every keyword adjustment creates another
   edge case.

Lane changes also alter the mounted tool set per turn. Bedrock's cache hierarchy
is tools -> system -> messages, so tool-set churn invalidates the downstream
prompt cache.

## Decision

Use one standard chat lane on **Claude Sonnet 4.6** and let the model decide
whether to call a tool.

- Every standard chat turn runs on `sonnet-4-6` with the user's stable,
  authorized tool set mounted.
- The mounted set contains approved and connected provider facades (Google,
  Notion, Salesforce, GitHub) plus configured builtin web tools.
- The model sees the tool names, descriptions, and schemas and decides whether
  a tool is needed. Chit-chat remains an ordinary direct response; there is no
  preliminary classifier call.
- Provider choice moves from the ordered checks spread across `hasToolIntent`,
  `hasCapabilityBackedToolIntent`, and provider-specific helpers into precise
  tool descriptions. For example, calendar questions should prefer the
  connected Google Calendar tool over general web search.
- Tool availability remains authorization-driven. A disconnected or
  unconfigured capability is not mounted and must not be claimed.
- `durable-local` detection remains separate. It selects the execution
  substrate for long-running work; it does not gate tool capability.
- `ROUTING_MODE=regex|model-decided` provides a temporary rollout and rollback
  switch. `model-decided` becomes the default after behavioral evaluations pass;
  the regex implementation is deleted after one stable release.

Sonnet 5 is explicitly not part of this change. Account invocation access is
pending AWS Support, and the Sonnet 4.6 benchmark already meets the product's
latency and tool-selection goals.

## Why Sonnet 4.6

The fixed production-like Bedrock benchmark completed 18 calls across three
prompt classes (chit-chat, current information, and connected-provider data),
three runtime configurations, and cold/warm cache states.

| Scenario | Phase | p50 first event | p50 first text | p50 total | Cache read |
| --- | --- | ---: | ---: | ---: | ---: |
| Haiku 4.5, tool-less | cold | 993 ms | 993 ms | 1991 ms | 0% |
| Haiku 4.5, tool-less | warm | 854 ms | 854 ms | 2054 ms | 0% |
| Sonnet 4.6, full tools | cold | 1099 ms | 1059 ms | 1461 ms | 60.6% |
| Sonnet 4.6, full tools | warm | 1025 ms | 991 ms | 1473 ms | 97.0% |
| Haiku 4.5, full tools | cold | 1176 ms | 1176 ms | 1479 ms | 60.6% |
| Haiku 4.5, full tools | warm | 1182 ms | 1182 ms | 1395 ms | 97.0% |

The run cost an estimated $0.1173 at standard rates. Sonnet 4.6:

- used no tool for chit-chat;
- called `web__search` for current-information prompts;
- called `google__list_events` for provider prompts;
- made the same decisions in cold and warm runs;
- reached warm first text in 991 ms, only 137 ms behind tool-less Haiku; and
- reached 97% cache reuse on the stable full-tool prefix.

The benchmark passes the issue's latency guardrail (within 1.5x of tool-less
Haiku) and makes a separate escalation lane unnecessary.

## Architecture

### Stable tool catalog

Build the mounted tool catalog from the requesting user's effective grants and
provider state. Keep ordering and schemas deterministic. Within a conversation,
the catalog changes only when the user connects, disconnects, enables, or
disables a capability.

`packages/agent/src/clients.ts` places a Converse cache checkpoint after the
stable tools and system prefix. The
[Amazon Bedrock prompt-caching table](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)
lists a 1,024-token minimum per checkpoint for Sonnet 4.6 and a 4,096-token
minimum for Haiku 4.5. The measured full prefix is approximately 11,085 tokens,
so it clears both minimums.

Cache telemetry must preserve these values separately:

- uncached input tokens;
- cache-read input tokens;
- cache-write input tokens; and
- output tokens.

They remain visible in run telemetry so cache behavior and cost can be audited
after rollout.

### Model decision

The system prompt describes capability boundaries and requires tool honesty,
but it does not contain keyword routing rules. Tool descriptions carry the
selection guidance the model needs:

- use connected first-party data for questions about that user's work;
- use web search for current public information;
- do not use a tool when the answer is conversational or self-contained; and
- never report a write as complete unless the corresponding write tool
  succeeded.

The model may answer directly or emit one or more native Bedrock tool-use
blocks. The existing agent loop executes authorized calls and returns results
to the model.

### Runtime selection

When `ROUTING_MODE=model-decided`:

1. Determine whether the turn needs the durable execution substrate using the
   existing non-capability rules.
2. Select `sonnet-4-6` for the standard chat turn.
3. Mount the stable authorized tool catalog without inspecting message text.
4. Let the model answer directly or call tools.

The following no longer influence the standard model or mounted tool catalog:

- `hasToolIntent`;
- `hasWebSearchIntent`;
- `hasCapabilityBackedToolIntent` and its provider-specific helpers;
- prior-turn keyword stickiness; and
- message-length-based Haiku selection.

The message-length heuristic is a model-selection concern rather than a
provider-precedence rule. Model-decided mode deliberately bypasses it for this
rollout; longer-term economy-model selection remains in #303's scope.

The old path remains intact only while `ROUTING_MODE=regex` is selected during
the guarded rollout.

## Delivery plan

Each phase is a focused PR through CI, Product Smoke, and Claude review.

### P1 - Telemetry and benchmark

- Preserve cache read/write token fields through Bedrock events, the agent loop,
  and run telemetry.
- Add the bounded 18-call benchmark and dry-run path.
- Record the result table in #364.

Status: complete in #367; benchmark passed on Sonnet 4.6.

### P2 - Model-decided routing flag

- Add `ROUTING_MODE=regex|model-decided` with a safe parser and explicit tests.
- Under `model-decided`, mount the stable per-user catalog on every standard
  turn and bypass regex capability routing.
- Use Sonnet 4.6 for standard model-decided turns.
- Keep durable execution selection, authorization checks, self-hiding tools,
  cancellation, retry, and resume behavior unchanged.
- Preserve the selected routing mode on a run so retry/resume does not silently
  change semantics during a deployment.

### P3 - Behavioral routing evaluations

Move intent confidence from regex unit tests to behavioral evaluations. The
evaluation set must cover at least:

- "who won the england norway game?" -> calls web search;
- "what's on my calendar today?" -> calls Google Calendar, not web;
- "do I have new mail?" -> calls Gmail and reasons over the returned messages;
- "score this essay" -> no web call;
- "what are you doing this weekend?" -> no web call;
- "how are you?" -> no tool call;
- disconnected web/provider states -> no unavailable tool claim; and
- multi-turn follow-ups -> preserve provider context without keyword matching.

CI keeps deterministic contract tests. Paid behavioral evaluations run through
the established eval workflow and publish tool-decision and honesty results.
The model-decided path must meet or beat the regex baseline on positive cases
with zero capability-honesty regressions in the regression set.

### P4 - Flip, soak, and delete

- Set production `ROUTING_MODE=model-decided` after P2 and P3 pass.
- Run production smoke tests for direct chat, web search, connected-provider
  reads/writes, retry, resume, and durable work.
- Monitor first-token latency, cache-read ratio, tool error rate, honesty
  failures, and cost for one release.
- Delete regex capability-routing code and obsolete regex tests after the soak.
- Keep the environment flag for one additional release as a break-glass
  rollback, then remove it.

## Acceptance criteria

- Natural current-information questions reach web search without routing
  keywords.
- Provider questions call the correct connected provider rather than web.
- Chit-chat and self-contained writing requests do not call tools.
- The assistant never denies a mounted capability or claims an unmounted one.
- Standard model-decided turns use Sonnet 4.6.
- The mounted catalog is deterministic and scoped to the requesting user.
- Cache-read and cache-write tokens remain distinct and measurable.
- Warm p50 first text remains within 1.5x of the tool-less baseline.
- Existing cancellation, retry, resume, attachments, artifacts, and durable
  execution behavior remains green.

## Non-goals

- Sonnet 5 enablement or rollout.
- A trained classifier router.
- A Haiku escalation call before normal chat.
- Deferred tool loading or tool search; the current per-user catalog remains
  below the observed 30-50-tool degradation range.
- Changes to OAuth grants, provider authorization, or data scoping.
- Changes to how long-running work is scheduled.

## Risks and controls

- **Tool over-calling:** behavioral no-tool cases gate rollout; descriptions say
  when a tool is and is not appropriate.
- **Wrong provider:** provider-first descriptions plus behavioral evaluations
  test selection against web search.
- **Latency or cost regression:** benchmark budgets are already met; production
  telemetry and the rollback flag protect rollout.
- **Cache misses from catalog churn:** deterministic schemas and ordering keep
  the prefix stable; cache-read telemetry exposes regressions.
- **Authorization leakage:** catalog construction continues to use existing
  per-user grants and provider status; disconnected tools never mount.

## Rejected fallback

The original fallback was a tool-less Haiku lane with one
`escalate_to_tools` tool. It remains model-decided but adds a second model
round-trip on every tool-bearing request and preserves two runtime paths. The
Sonnet 4.6 benchmark met the latency target while choosing tools correctly, so
the extra lane has no demonstrated benefit and is rejected for this rollout.
