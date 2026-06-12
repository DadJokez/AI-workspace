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

# Free structural-only run (proves wiring, NOT behavior)
pnpm eval --mock
```

A full real run is ~9 cases, under a minute, ~$0.006. Reports land in
`packages/evals/eval-reports/` (gitignored) as JSON + Markdown. Exit code is
non-zero on any failure, so it gates in CI.

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

Next capabilities to add (need the app stack / GitHub, so they run as a
follow-up tier): tool no-hallucination, the slash-palette redirect, redaction.
