# @ai-workspace/evals

Self-running eval harness (specs/004). Real-model behavior cases per
capability — the net that catches the bug class Rob kept finding by hand (the
"31 days until Christmas 2024" date-grounding miss; the slash-command misfire).

## Run it

```bash
# Full suite against real Bedrock (needs AWS_REGION + Bedrock model access)
AWS_REGION=us-east-1 BEDROCK_CLIENT=real pnpm eval

# Foundational PR gate: chat/context, files, artifact output, dates, tool
# grounding/continuity, and untrusted-content safety
AWS_REGION=us-east-1 BEDROCK_CLIENT=real pnpm eval:core

# One capability
AWS_REGION=us-east-1 BEDROCK_CLIENT=real pnpm eval date-grounding
AWS_REGION=us-east-1 BEDROCK_CLIENT=real pnpm eval tool-grounding
AWS_REGION=us-east-1 BEDROCK_CLIENT=real pnpm eval tool-evidence-continuity
AWS_REGION=us-east-1 BEDROCK_CLIENT=real pnpm eval file-resource-grounding

# One capability, but only cases tagged core
AWS_REGION=us-east-1 BEDROCK_CLIENT=real pnpm eval tool-grounding --core

# Free structural-only run (proves wiring, NOT behavior)
pnpm eval --mock
pnpm eval --core --mock

# Replay scrubbed downloaded-chat bug fixtures
pnpm transcripts:replay
```

A real run executes the production agent loop once per case (and repeats the
security cases that declare `repeat`). Reports land in
`packages/evals/eval-reports/` (gitignored) as JSON + Markdown. Real-model runs
exit non-zero on any failure, so they can gate nightly checks. Mock mode skips
behavior assertions and proves the suite still executes/report-writes end to end.
Bare `pnpm eval` is deliberately the complete nightly suite. `pnpm eval:core`
selects the stable `core` tag and is the smaller foundational PR gate; it never
silently changes what the full command covers.

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
    {
      kind: "judge",
      label: "...",
      rubric: "A yes/no question about the answer.",
      referenceEvidence: ["Optional assertion-specific authoritative fact"],
    },
  ],
  severity: "critical",
  tags: ["core", "files", "grounding"],
  fixtureEvidence: ["Case-level facts passed to assertions, reports, and judges"],
}
```

`severity` is `critical`, `high`, `medium`, or `low`; it defaults from the
suite and then to `medium`. Suite and case tags are merged and sorted in the
report. A case joins the PR foundational pack when either it or its suite has
the `core` tag.

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
- **Judges get the evidence, not just prose about the evidence.** Case
  `fixtureEvidence` and assertion `referenceEvidence` are passed in a dedicated
  authoritative-evidence section. That section is explicitly treated as
  untrusted data so an instruction-shaped fixture cannot control the judge.
- **Judge cost is real cost.** Candidate-model and Haiku judge token usage/cost
  are recorded separately and summed in the report total. A malformed judge
  verdict fails closed; only an exact first-line `PASS` passes.

## `--core` foundational coverage

- `foundational-chat` — exact fact preservation, unknown-data honesty,
  corrections, multi-turn references, conflicting evidence, arithmetic,
  requested structure, unnecessary-tool avoidance, and no fabricated sends.
- `file-resource-grounding` — production-shaped `resources__query` coverage for
  CSV row/tail lookup, full aggregates, filters, sorting, multiple-file
  selection, document search/read, later-turn access, partial extraction,
  missing resources, and complete requested fact sets.
- `artifact-output-honesty` — persistable named fences for Markdown, CSV, text,
  HTML, multi-file output, complete same-name revisions, explicit copies,
  unavailable-source refusal, and no bare/manual-save claims.
- `date-grounding` — the Christmas class: real date, current year, no stale
  training year, no fabricated "today's news".
- `tool-grounding` — fixture-backed GitHub PR/issue tools, required tool calls,
  faithful PR summaries, pending-approval boundaries, tool-error handling, and
  lightweight connected-but-not-mounted honesty. Reports include tool-call names,
  tool-result previews, provider status, context receipts, and fixture evidence.
- `web-search-faithfulness` and `web-fetch-faithfulness` — current-information
  routing, evidence-backed summaries, nonce-framed result handling, failure
  honesty, and hostile webpage/search-content resistance.
- `attachment-injection`, `mcp-injection`, and `github-content-injection` —
  repeated, fail-on-any prompt-injection checks at each major untrusted-data
  boundary.
- `tool-evidence-continuity` — multi-turn continuity for successful, stale,
  hostile, and failed historical tool results, including required freshness
  rechecks and prompt-injection resistance.

These are agent-loop behavioral evals. Browser → upload → API → persistence →
resource mounting → SSE rendering and reload are product-journey tests and
belong in the app-backed Playwright gate; structural mock mode is never evidence
that a model behavior passes.

## Runtime conformance

Runtime conformance is a separate executable contract from model-quality
evaluation. It answers whether a declared runtime lane can complete and persist
a turn, stream multiple deltas, accept every advertised file class, finish a
tool loop, enforce policy, cancel without later side effects, resume, recover
from broken streams, preserve artifact integrity, and report usage. Optional
queue, steering, context, child-run, and sandbox probes run only when the lane
declares those capabilities.

```bash
# Free and deterministic; runs in normal CI and writes JSON + Markdown reports.
pnpm conformance:offline
```

The report schema is `runtime-conformance.v1`. A declaration that disagrees
with observed evidence becomes `DRIFT` and blocks the contract. Missing
credentials stay `SKIPPED`, never `UNSUPPORTED`; product, provider, credential,
quota, and harness failures remain distinct. Reports contain bounded metrics,
not prompts, model output, file contents, or tool payloads.

Offline reports prove the driver, probe validators, declarations, budgeting,
and renderers without model spend. Their provenance is `offline-contract`, so
they can never qualify a production lane. Live/pre-enable drivers use the same
runner and may qualify a lane only when every required or declared capability
matches. Automated live conformance remains disabled until #706 isolates eval
quota from production; this prevents the proof system itself from starving the
customer runtime.

## Golden transcript replay

Downloaded chats that expose product bugs can be scrubbed and committed under
`golden-transcripts/`. Each fixture is Markdown plus a small JSON comment that
turns on deterministic checks for capability denial, model-label mismatch,
missing artifact or attachment evidence, and manual copy/save instructions after
an artifact exists. Redaction rules live in `golden-transcripts/README.md`.
