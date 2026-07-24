---
name: comparative-browser-evals
description: Run Comparative's agent-as-user canaries through the Codex in-app Browser. Use for nightly or pre-release UX evaluation of real chat/file continuity and artifact creation/revision, or when checking whether a browser-operating Codex agent can discover and complete core workflows without API or database shortcuts.
---

# Comparative Browser Evals

Exercise Comparative as a user would through the Codex in-app Browser. Keep
this advisory lane separate from required Playwright and behavioral gates.

## Preconditions

1. Read `references/scenarios.json` completely.
2. Use the Codex in-app Browser explicitly. Do not substitute Chrome,
   standalone Playwright, a connector, direct HTTP calls, or database queries
   for scenario actions or observations.
3. Use the target URL from the invoking prompt, defaulting to
   `https://comparative.builtwithrobot.link`.
4. Require the invoking prompt to name the dedicated canary account's expected
   visible display label. Verify that label in the rendered account control.
   If it is absent, a different identity is visible, or the target redirects to
   sign-in, return `BLOCKED`; never claim a pass.
5. Require explicit authorization in the invoking prompt before uploading
   `assets/codex-browser-canary.csv`. Upload no other local file.

## Run The Canaries

1. Create one UTC run id in the form `CBX-YYYYMMDD-HHMMSS`. Substitute it for
   every `{RUN_ID}` token in the scenario contract.
2. Acquire the Codex in-app Browser. If it is unavailable, mark the entire
   suite `BLOCKED`; do not substitute another browser.
3. Preflight the target once:
   - the chat route renders meaningful content;
   - the visible account control matches the expected canary label;
   - the composer becomes enabled within 30 seconds;
   - no framework error overlay or page error is visible.
4. Run scenarios in contract order. Start each from a new chat. Interact only
   through controls discoverable from the rendered page.
5. For file input, use the Browser file-chooser capability with the absolute
   path to the committed synthetic CSV. If the current Browser surface does
   not expose file upload, classify that scenario `BLOCKED`, not `PASS`.
6. Capture the required screenshots and retain the thread URL after the first
   successful send. Reload that exact URL for durability checks.
7. Treat screenshots as triage evidence, not grading evidence. Grade only the
   observable exact assertions in the scenario contract.
8. Inspect the visible page after each scenario. Read error-level browser logs
   through the selected Browser's supported developer-log capability when it
   exists. If it does not exist, record that limitation in `uxNotes`; do not
   infer clean logs. A visible framework overlay remains a hard failure.
9. Record discoverability, wording, layout, or focus friction as qualitative
   notes; do not let a note override a failed hard assertion.

## Classify Results

- `PASS`: every critical assertion passed and the weighted score meets the
  scenario threshold.
- `FAIL`: the app loaded, but a product action or assertion failed.
- `BLOCKED`: authentication, target availability, site permission, or a
  missing Browser capability prevented the scenario from starting or
  continuing before product behavior could be graded.

Do not retry a product mutation or infrastructure interruption in the same
run. Record the failure or blocker; a later scheduled or manual run is a new
attempt.

Return one JSON object:

```json
{
  "runId": "CBX-YYYYMMDD-HHMMSS",
  "target": "https://…",
  "overall": "PASS|FAIL|BLOCKED",
  "scenarios": [
    {
      "id": "CBX-CORE-CSV-001",
      "status": "PASS|FAIL|BLOCKED",
      "score": 100,
      "threadUrl": "https://…",
      "assertions": [
        {
          "id": "csv-visible-before-send",
          "passed": true,
          "evidence": "…",
          "notRunReason": null
        }
      ],
      "screenshots": ["csv-before-send", "…"],
      "errors": [],
      "uxNotes": []
    }
  ]
}
```

For a scenario blocked before any assertion runs, use `score: 0`,
`threadUrl: null`, and `assertions: []`. If some assertions ran before a
blocker, include every assertion with `passed: true`, `false`, or `null`; use
`notRunReason` when `passed` is `null`.

Overall status is the worst scenario status, with `FAIL` worse than `BLOCKED`.
Never convert an unsupported capability, login page, timeout, or partial run
into a green result.

When a canary finds a product defect, preserve its run id and evidence, then
add the cheapest deterministic Playwright, integration, or behavioral
regression with the fix.
