# Bug: re-attaching a file drops prior conversation context

**Labels:** `bug`, `high`, `agent-runtime`
**Severity:** High

## Summary

Mirror image of issue 04. Re-attaching the data file (the workaround for the lost resource binding) started the agent with **no access to the prior conversation** — it responded: *"I don't have a prior conversation thread with the 8 specific 'unverified' claims visible to me — that context was not included here."*

So the two halves of the working state are never available together:

| Turn state | File tools | Conversation memory |
|---|---|---|
| Follow-up, no re-attach | ❌ (issue 04) | ✅ |
| Follow-up, file re-attached | ✅ | ❌ (this issue) |

The only reliable pattern is stuffing all required context and the attachment into a single message — which users won't know to do.

## Reproduction

1. Run a multi-turn analysis conversation referencing earlier findings.
2. Re-attach the same file in a new message with a prompt that depends on prior turns ("settle the 8 claims you marked unverified").

**Expected:** attachment adds a resource; conversation history remains.
**Actual:** agent has the file but cannot see the prior thread.

## Mechanism — confirmed in run trace

The context receipt for run `82fca145-b464-4ede-95cb-ae1a7f61e614` shows the exact cause:

> `recentMessages: 1` · *"Historical tool evidence: 0 successful and 0 failed result(s) included; **43 omitted by the 0-character budget**."*

When a file is attached, the context assembler allocates **zero characters** to prior tool evidence and includes only the current message — the ~200k-char inline attachment (see issue 09) has consumed the budget that conversation history would have used. The 43 omitted tool results were the entire prior analysis.

**A/B confirmation** from the same thread: the no-attachment run `154ce7e7` got `recentMessages: 13` and an **8,000-character** tool-evidence budget (10 results included); the with-attachment run `82fca145` got `recentMessages: 1` and a **0-character** budget (43 results omitted). The attachment is the only variable.

## Suggested fix

Treat attachments as additive to the session, never as a session reset. Reserve a minimum history budget that attachments cannot evict (fixing issue 09's inline-injection also frees ~200k chars for history). If re-attachment forks a new context for technical reasons, say so in the UI.
