# Spec — Eval & Optimization Loop

> Builds on the **existing** eval harness ([packages/evals](../../../packages/evals/),
> [specs/004-eval-harness/spec.md](../../../specs/004-eval-harness/spec.md), `pnpm eval` +
> `transcripts:replay`). The goal: reuse our data-driven cases, add AgentCore Evaluations + A/B as the
> promotion gate.

## Assumptions

- AgentCore Evaluations score traces with LLM-as-judge (helpfulness/faithfulness/safety) or custom
  evaluators; AgentCore Optimization proposes prompt/tool-description changes and validates via A/B
  with statistical-significance reporting per session (doc-sourced).
- Our existing cases are **data files**, addable in <5 min, mixing assertions (deterministic) + judge
  (qualitative), with regression locks for shipped bugs ([specs/004](../../../specs/004-eval-harness/spec.md)).
- Evals run against **real Bedrock on local/CI** (no prod test-auth backdoor) — clean for IT review
  ([specs/004 spec.md:22](../../../specs/004-eval-harness/spec.md)).

## Evaluators

| Evaluator | Type | What it checks |
|---|---|---|
| Helpfulness | AgentCore LLM-judge | did it answer the user's actual ask |
| Faithfulness / grounding | AgentCore LLM-judge | claims supported by tool results / context; **no fabricated tool results** (the product spine, [CLAUDE.md] priority 3) |
| Safety | AgentCore LLM-judge | no policy violations, no secret leakage |
| **Honesty (custom)** | custom evaluator | never denies a capability/data it has; never misstates model/identity/date — encodes the GitHub/identity/artifact/"Christmas" bug history ([specs/004](../../../specs/004-eval-harness/spec.md)) |
| **Date-grounding (assertion)** | deterministic | correct current date present when asked ("Christmas bug" lock) |
| **Tool-called (assertion)** | deterministic | the expected tool actually fired (not hallucinated) |
| **Valid-JSON / schema (assertion)** | deterministic | structured outputs parse |
| **Attestation honesty (custom)** | custom | unattested provider ⇒ "connect X" message, not silent fallback ([specs/001](../../../specs/001-runtime-v2-autopilot/spec.md), [specs/002](../../../specs/002-skills-spine/spec.md)) |

## Test datasets

- **Reuse** the existing per-capability case files (5–7 each: 2–3 standard, 1–2 edge, + bug locks)
  from [packages/evals/src/cases](../../../packages/evals/src/) (e.g. `tool-grounding.cases.ts`).
- **Add Harness-specific cases:** mid-session model switch keeps context; Gateway target auth scoping
  (user A can't reach user B's data); memory `actorId` isolation; skill-from-S3 loads correctly;
  Notion relay/passthrough parity.
- **Golden transcripts:** keep `transcripts:replay` ([package.json](../../../package.json)) as a
  regression net against recorded real sessions.

## A/B promotion criteria

1. Candidate = new harness **version** (prompt/tool-desc/skill/model change) on `STAGING`.
2. Run the affected capability's eval set (pre-merge gate, as today) — **hard fail** on any assertion
   regression or honesty-evaluator drop.
3. A/B `STAGING` vs `PROD` version on mirrored/sampled traffic; AgentCore reports per-session
   significance.
4. **Promote** (repoint `PROD` to candidate) only if: no assertion regressions **and** judge/custom
   scores ≥ baseline **and** A/B win or tie at **p < 0.05** with **N ≥ 200 sessions** (raise N for
   smaller effect sizes).
5. **Rollback** = repoint `PROD` to prior version (instant) if post-promotion alarms fire
   ([observability-spec.md](observability-spec.md)).

## Statistical significance threshold

- Default **p < 0.05**, two-sided, with a **minimum detectable effect** declared per metric (e.g. ≥3-pt
  helpfulness, ≥5-pt faithfulness). Underpowered tests (N below the MDE sample) ⇒ "inconclusive, hold."
- Guard against peeking: fix N (or use AgentCore's sequential-test reporting if provided) before
  reading results.

## Optimization loop

- Let AgentCore Optimization propose prompt/tool-description edits; treat each as a **candidate
  version** that must pass the same gate above. **Never auto-promote** an optimizer suggestion — it
  goes through STAGING + eval + A/B like any human change (IT-review-friendly, keeps humans owning the
  prompt that defines product behavior).

## Cadence

- Nightly full eval (matches [specs/004](../../../specs/004-eval-harness/spec.md)); pre-merge affected-
  capability gate; continuous A/B for any candidate on STAGING.
