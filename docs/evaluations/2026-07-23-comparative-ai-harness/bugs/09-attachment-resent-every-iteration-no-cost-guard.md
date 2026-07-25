# Bug: file attachment re-sent to the model on every agent-loop iteration — ~890k input tokens for 1,237 output tokens

**Labels:** `bug`, `high`, `cost`, `agent-runtime`
**Severity:** High (root cause identified — supersedes the earlier "no cost guard" framing)

## Summary — root cause confirmed in run trace

Run `82fca145-b464-4ede-95cb-ae1a7f61e614` (one user turn, 55 seconds, 8 tool calls) consumed:

```
tokensIn: 890,530   (inputTokens: 822,658 uncached; cacheRead: 62,728; cacheWrite: 5,144)
tokensOut: 1,237
```

The cause is visible in the provider request snapshots: the uploaded CSV's inline extraction (~200k chars, `thread:message:1 charCount: 202,131`) is embedded in the user message, and the **entire message history including the attachment is re-sent on all 8 agent-loop iterations** with prompt caching almost entirely ineffective (62.7k cached vs 822.7k uncached). One turn ≈ the same file uploaded to the model eight times.

Compounding design issue: the file is *also* fully available through `resources__query` (the system prompt itself says the inline extraction is "truncated or metadata-only" and to use the tool) — so the inline copy is both redundant and the dominant cost driver.

## Impact

- ~$3 per multi-step turn on an 8 MB CSV; scales linearly with iterations × file size.
- Earlier in the same eval an equivalent turn reached ~1M tokens before stalling.

## Suggested fixes (ordered)

1. **Fix prompt caching across loop iterations and across turns** — the attachment block and system prompt are byte-identical between iterations; they should be near-100% cache reads after iteration 0. Cross-turn caching is also dead (`cacheReadInputTokens: 0` on run `ffb3e012`) because the volatile system suffix embeds per-turn timestamps and receipts, busting the cache prefix every turn.
2. **Don't inline file content when a queryable resource binding exists** — send the manifest only; the model already prefers `resources__query`.
3. Keep a per-turn token budget with a progress checkpoint as a backstop (original ask).

## Evidence

`provider_context_snapshot` (8 iterations, each carrying the full attachment block) and `run_completed.metadata.usage` in run `82fca145-b464-4ede-95cb-ae1a7f61e614`.

**A/B comparison**: run `154ce7e7` in the same thread performed a *larger* workload (12 successful queries, 4 iterations) with **no inline attachment** (`uploadedFilesInjected: false`) and consumed only **157,195 input tokens** — vs 890,530 for the attachment-inlined run with 8 queries. The inline attachment, not the query volume, is ~5x of the cost.
