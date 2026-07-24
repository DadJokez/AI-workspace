# @ai-workspace/evals

Self-running eval harness (specs/004). Real-model behavior cases per
capability — the net that catches the bug class Rob kept finding by hand (the
"31 days until Christmas 2024" date-grounding miss; the slash-command misfire).

## Run it

```bash
# Full suite against real Bedrock (needs AWS_REGION + Bedrock model access)
AWS_REGION=us-east-1 BEDROCK_CLIENT=real pnpm eval

# One capability
AWS_REGION=us-east-1 BEDROCK_CLIENT=real pnpm eval date-grounding
AWS_REGION=us-east-1 BEDROCK_CLIENT=real pnpm eval tool-grounding
AWS_REGION=us-east-1 BEDROCK_CLIENT=real pnpm eval tool-evidence-continuity

# Free structural-only run (proves wiring, NOT behavior)
pnpm eval --mock

# Replay scrubbed downloaded-chat bug fixtures
pnpm transcripts:replay
```

A full real run is ~20 cases, under a minute, roughly one cent. Reports land in
`packages/evals/eval-reports/` (gitignored) as JSON + Markdown. Real-model runs
exit non-zero on any failure, so they can gate nightly checks. Mock mode skips
behavior assertions and proves the suite still executes/report-writes end to end.
Every case report includes stable `thread=` and `run=` debug IDs. Pure harness
cases use synthetic `eval-thread:*` / `eval-run:*` IDs; app-backed reproductions
can set real Comparative IDs so admins can open `/admin/runs/{runId}` and inspect
the stored context receipt, route receipt, mounted-provider state, and
recommendation candidates.

## Add a case (the whole point)

Cases are **data, not code**. When a bug is found, lock it in by editing one
file under `src/cases/` — no harness changes:

```ts
{
  id: "my-new-case",
  description: "what it checks",
  systemPrompt: "optional — e.g. a skill's instructions",
  input: "the user message",
  assertions: [
    // Prefer deterministic — exact, free, stable across runs.
    { kind: "deterministic", label: "...", check: (t) => t.answer.includes("...") },
    // Use judge sparingly, for qualitative calls code can't make.
    { kind: "judge", label: "...", rubric: "A yes/no question about the answer." },
  ],
}
```

## Lessons baked in (from building it)

- **Prefer deterministic assertions.** Judge calls flake run-to-run and nitpick
  correct answers. Every judge rubric here was rewritten at least once; the
  deterministic checks never moved. If code can check it, code checks it.
- **Test the capability, not adjacent weaknesses.** The date-grounding suite
  asserts grounding (real date, right year), not the model's mental arithmetic —
  those are different things and conflating them makes a flaky test.
- **Write rubrics for the *best* acceptable behavior, not one specific shape.**
  The model flagged a prompt injection instead of silently ignoring it (better!)
  and a too-narrow rubric failed it.

## What's covered (v1)

- `date-grounding` — the Christmas class: real date, current year, no stale
  training year, no fabricated "today's news".
- `skill-faithfulness` — Meeting Notes → Actions (owners from source, asks when
  empty), Email Drafter (subject + brevity), Executive Brief (faithful facts +
  allowed analysis), prompt-injection resistance.
- `context-faithfulness` — Vault truthfulness, connected-tool honesty, route
  receipt honesty, skill/app/automation recommendations, and exact capability
  boundaries.
- `tool-grounding` — fixture-backed GitHub PR/issue tools, required tool calls,
  faithful PR summaries, pending-approval boundaries, tool-error handling, and
  lightweight connected-but-not-mounted honesty. Reports include tool-call names,
  tool-result previews, provider status, context receipts, and fixture evidence.
- `tool-evidence-continuity` — multi-turn continuity for successful, stale,
  hostile, and failed historical tool results, including required freshness
  rechecks and prompt-injection resistance.

Next capabilities to add (need the app stack, production-like auth, or persisted
chat state): slash-palette redirect, redaction, and admin/debug replay of failed
context packs.

## Golden transcript replay

Downloaded chats that expose product bugs can be scrubbed and committed under
`golden-transcripts/`. Each fixture is Markdown plus a small JSON comment that
turns on deterministic checks for capability denial, model-label mismatch,
missing artifact or attachment evidence, and manual copy/save instructions after
an artifact exists. Redaction rules live in `golden-transcripts/README.md`.
