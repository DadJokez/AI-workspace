# Bug: in-flight runs suspend ("needs attention") with no indication they are resumable

**Labels:** `bug`, `medium`, `ux`, `agent-runtime`
**Severity:** Medium

## Summary

Mid-analysis, the run stopped with **"Worked for 44s · 1 step needs attention"** and a spinner. Nothing indicated whether the run was dead, paused on the pending scheduling card (issue 06), or waiting on the failed step (issue 07). It looked like a hard failure; in fact, typing **"continue"** resumed it and prior step results were preserved.

## Reproduction

1. Cause a mid-run interrupt (a suggestion card or a failed step).
2. Observe the run state UI.

**Expected:** explicit state — "paused: waiting on approval/failed step — reply 'continue' or dismiss the card to resume" — or auto-resume after the interrupt is resolved.
**Actual:** ambiguous stall; resumption discoverable only by experimentation. Two consecutive stalls in one task each required a manual "continue."

## Impact

Users abandon recoverable runs (and re-pay for them — the stalled turn had already consumed ~890k tokens). Support burden: "it just stopped" reports for what is actually a pause.

## Suggested fix

- Label suspended runs with the blocking reason and the resume affordance.
- Auto-resume when the blocking interrupt is dismissed/approved.
- Don't let unrelated suggestion cards (issue 06) block continuation at all.
