# Bug: run-trace/step UI redacts tool error semantics the model was allowed to see

**Labels:** `bug`, `low`, `observability`
**Severity:** Low (revised down — original report overstated this)

## Summary — CORRECTED after run-trace inspection

Original report claimed the *agent* could not see tool error details. The run trace disproves that: for failed call `tooluse_qxtAymssxx2Ia8idC5XJub`, the **model received the real error** ("Operation \"search\" is not valid for a tabular resource") inside the tool-result block and recovered correctly on the next step.

What actually happens: the **step trace and audit log** replace the error with `{ "redacted": true }` and the string *"Conversation resource tool failed; file content was redacted from this log."* — for an error message that contains **no file content at all**. The redaction policy (`trace-redaction.v1`) is scrubbing error semantics, not data.

## Impact

- Users and evaluators debugging a stalled run see "Could not search Resources → redacted" and cannot tell a validation error from an infrastructure failure. In our eval this led directly to a wrong root-cause hypothesis.
- The model is fine; the humans are blind.

## Reproduction

1. Trigger any failing `resources__query` (e.g. `operation: search` against a tabular resource).
2. Compare the tool-result the model received (full error text) with the run-inspector step detail (`{"redacted": true}`).

## Suggested fix

Redact values, not structure: pass through error class and message when they contain no cell data (the common case for validation errors). Reserve content redaction for errors that actually embed file contents.

## Evidence

Run `82fca145-b464-4ede-95cb-ae1a7f61e614`, sequence 14 (`tool_result`, status `failed`) vs. iteration-4 provider snapshot showing the un-redacted error in the model's message history.
