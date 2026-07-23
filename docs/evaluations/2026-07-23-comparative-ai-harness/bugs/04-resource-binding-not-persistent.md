# Bug: dataset resource binding not persistent across turns — query tools silently vanish

**Labels:** `bug`, `high`, `agent-runtime`
**Severity:** High — causes model confabulation downstream

## Summary

The query tool bound to an attached file is only mounted in turns where the runtime considers the resource "active." On follow-up turns in the same conversation, the tool can be absent — the agent reported having only Google/Salesforce/web-search tools while being asked to query a file analyzed one turn earlier. The agent itself described the behavior: *"it fires automatically when I process a request in a turn where the file resource is active… sometimes the binding reactivates on a fresh turn."*

## Why this is worse than it sounds

In our eval, a turn where the binding silently failed to mount produced a full analysis report of **fabricated numbers** — the model, unable to query, estimated from context and did not disclose it. Nondeterministic tool mounting converts directly into silent data fabrication unless the model happens to disclose (it did so only under a prompt demanding exact query-sourced figures).

## Reproduction

1. Attach a CSV; ask for analysis (tool mounts, queries run).
2. In a later turn, ask a follow-up requiring fresh queries without re-attaching the file.
3. Inspect whether the query tool is in the turn's tool manifest.

**Expected:** dataset bindings persist for the session, or the agent can explicitly re-mount a known resource.
**Actual:** binding intermittently absent; agent must ask the human to re-attach and "hope the binding reactivates."

## Mechanism — confirmed in run trace

Run `154ce7e7-afbc-40e6-9539-897ce6cd293d`: `resourceResolution` selects resources with `resolverReason: "explicit_filename"` or `"current_upload"` — i.e. the query tool mounts only when the turn's message names the file or carries an attachment. A natural follow-up ("how is the business trending?") matches neither, so the binding silently drops. The failing run itself (`ffb3e012`) confirms it end to end: `resourceResolution: {intent: false, status: "none", selected: []}`, mounted tools `google, salesforce` only, and **zero tool calls in the entire run** — the fabricated trends analysis was a single no-tools completion (18.8k tokens in, 43s). The same trace's history contains the model explicitly reporting the consequence in an earlier turn: *"The resource query tool that read thy orders.csv is not mounted in this conversation turn, so I cannot fire new deep-dive queries right now."* One turn after that honest disclosure, the same unmounted state produced a fabricated analysis instead — nondeterministic mounting converts directly into silent fabrication risk.

## Suggested fix

- Pin file resource bindings for the life of the conversation (or until explicitly detached) — do not gate on filename mention.
- Give the agent a `mount_resource(file_id)` tool so recovery doesn't require human retry.
- Log the per-turn tool manifest so mount failures are visible in traces.
