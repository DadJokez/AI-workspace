# Bug: scheduling intent classifier triggers on analyzed data content (injection surface)

**Labels:** `bug`, `high`, `security`, `agent-runtime`
**Severity:** High — prompt-injection-shaped architecture flaw + workflow disruption

## Summary

While verifying a user-pasted claim containing the words *"weekends see roughly 40% more orders per day than weekdays,"* the runtime's scheduling classifier interpreted the claim text as a request for a recurring job and interposed an approval card mid-run: *"Schedule this workflow — You mentioned a recurring cadence (weekdays)."* The pending interrupt then contributed to the run suspending (see issue 08).

## Why this is a security issue, not just UX

The trigger text was **data under analysis** (a claim to fact-check), not a user instruction. If the phrase "weekdays" in analyzed content can reach the workflow-intent layer and spawn an approval card, then content inside uploaded files — which is fully attacker-controllable — is reaching the same layer. Today it schedules a card; the same pathway is how injected content escalates to real actions.

## Reproduction

1. Paste a fact-check request whose *claim text* mentions a cadence ("weekdays", "every Monday", "each month").
2. Observe whether a scheduling suggestion/approval interrupt appears.

**Expected:** intent detection runs only over the user's actual instruction, and analyzed data content is treated as inert.
**Actual:** classifier fired on claim text; approval card blocked an in-flight analysis run.

## Suggested fix

- Scope intent classification to the instruction channel; exclude quoted claims, file contents, and tool results.
- Never let a pending suggestion card gate continuation of an unrelated in-flight run.

## Evidence — recurs on every affected turn

Run trace `82fca145-b464-4ede-95cb-ae1a7f61e614`: `run_completed.metadata.recommendations` shows a **new** `schedule_skill` card (`cadenceHint: "weekdays"`, reason: *"You mentioned a recurring cadence (weekdays)"*) minted again on this run — the trigger text is claim #7 of a fact-check request, i.e. data under analysis. Every turn containing the claims re-fires the card.
