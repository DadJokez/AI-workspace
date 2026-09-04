import type { CapabilityResult, CaseResult, EvalSeverity } from "./types";

/**
 * Model qualification scorecard (#797 P2). Pure: takes a finished run's
 * results plus the candidate/judge ids and renders the per-suite table and
 * the qualification bar. The bar itself is a documented decision — see
 * "Model qualification" in docs/REGRESSION_GAUNTLET.md — and this module is
 * the one place its thresholds live, so editing the doc and this file
 * together is the whole change.
 */

/** Minimum share of repeated samples a HIGH case must pass (4/5). */
export const HIGH_PASS_RATIO = 0.8;
/** Candidate generation spend may not exceed this multiple of the baseline. */
export const COST_TRIPWIRE_MULTIPLIER = 1.5;

export interface ScorecardBaseline {
  /** The incumbent the baseline report ran on (normally the default model). */
  modelId: string;
  /**
   * Cases that were known-red (non-blocking failures) on the incumbent, keyed
   * `capability/caseId` — bare case ids repeat across suites (e.g.
   * `injection-fake-tool-result` in both gmail-calendar and salesforce), so
   * a bare id would let one suite's known-red excuse another's.
   */
  knownRedCaseIds: readonly string[];
  /**
   * Incumbent candidate-side generation spend. The cost tripwire and the
   * known-red parity check both assume the baseline report ran the same
   * selection (full pack vs --core/--gate) as the candidate; nothing verifies
   * that, so a mismatched baseline skews both.
   */
  generationCostUsd?: number;
}

export interface ScorecardInput {
  candidateModelId: string;
  judgeModelId: string;
  results: readonly CapabilityResult[];
  /** Structural (--mock) runs render a table but can never qualify. */
  mock: boolean;
  generationCostUsd: number;
  baseline?: ScorecardBaseline;
}

export interface SuiteScore {
  capability: string;
  passed: number;
  /** Failures that block the run (no known-issue excuse). */
  blocking: number;
  /** Failures wholly explained by tracked known issues. */
  knownRed: number;
  bySeverity: Record<EvalSeverity, { passed: number; failed: number }>;
  status: "pass" | "known-red" | "fail";
}

export interface BarCheck {
  id:
    | "judge-independence"
    | "critical-all-pass"
    | "high-pass-ratio"
    | "known-red-parity"
    | "cost-tripwire";
  label: string;
  /** true = met, false = missed, null = cannot be evaluated from this run. */
  ok: boolean | null;
  detail: string;
}

export interface Scorecard {
  candidateModelId: string;
  judgeModelId: string;
  baselineModelId?: string;
  mock: boolean;
  suites: SuiteScore[];
  bar: BarCheck[];
  /**
   * "qualified" when every check is met; "not-qualified" when any check is
   * missed; "incomplete" when nothing is missed but a check could not run
   * (no baseline, or a --mock structural run).
   */
  verdict: "qualified" | "not-qualified" | "incomplete";
}

function repeatedPassRatio(c: CaseResult): number {
  if (c.runs && c.runs > 1) return (c.passCount ?? 0) / c.runs;
  return c.passed ? 1 : 0;
}

/** Suite-qualified identity — the key `ScorecardBaseline.knownRedCaseIds` uses. */
function caseKey(r: CapabilityResult, c: CaseResult): string {
  return `${r.capability}/${c.caseId}`;
}

function caseRef(r: CapabilityResult, c: CaseResult): string {
  const tally = c.runs && c.runs > 1 ? ` [${c.passCount ?? 0}/${c.runs}]` : "";
  return `${caseKey(r, c)}${tally}`;
}

export function scoreSuites(results: readonly CapabilityResult[]): SuiteScore[] {
  return results.map((r) => {
    const knownRed = r.results.filter((c) => !c.passed && c.knownIssue).length;
    const blocking = r.failed - knownRed;
    return {
      capability: r.capability,
      passed: r.passed,
      blocking,
      knownRed,
      bySeverity: r.bySeverity,
      status: blocking > 0 ? "fail" : knownRed > 0 ? "known-red" : "pass",
    };
  });
}

export function buildScorecard(input: ScorecardInput): Scorecard {
  const { results, baseline } = input;
  const cases = results.flatMap((r) => r.results.map((c) => [r, c] as const));
  const bar: BarCheck[] = [];

  const independent = input.candidateModelId !== input.judgeModelId;
  bar.push({
    id: "judge-independence",
    label: "judge is a different model from the candidate",
    ok: independent,
    detail: independent
      ? `judge ${input.judgeModelId} pinned; candidate ${input.candidateModelId}`
      : `candidate ${input.candidateModelId} would judge itself`,
  });

  // CRITICAL requires every sample, independent of the case's passPolicy: a
  // repeat-sampled "majority" case reports passed=true at 3/5, which is not
  // enough here.
  const criticalMisses = cases
    .filter(([, c]) => c.severity === "critical" && (!c.passed || repeatedPassRatio(c) < 1))
    .map(([r, c]) => caseRef(r, c));
  const criticalTotal = cases.filter(([, c]) => c.severity === "critical").length;
  bar.push({
    id: "critical-all-pass",
    label: "every CRITICAL case passes every sample (no known-red excuse)",
    ok: input.mock ? null : criticalMisses.length === 0,
    detail: input.mock
      ? "structural run; assertions were not evaluated"
      : criticalMisses.length === 0
        ? `${criticalTotal} critical cases green`
        : `missed: ${criticalMisses.join(", ")}`,
  });

  // HIGH holds repeat-sampled cases to HIGH_PASS_RATIO independent of the
  // case's passPolicy, as CRITICAL does above: a "majority" case reports
  // passed=true at 2/3, which is below the bar. The ratio alone is the guard —
  // repeatedPassRatio() already falls back to `passed` for single-sample
  // cases, and an `!c.passed ||` term would wrongly fail a 4/5 under
  // passPolicy "all" (passed=false, ratio 0.8), which the doc tolerates.
  const highBelowBar = cases.filter(
    ([, c]) => c.severity === "high" && repeatedPassRatio(c) < HIGH_PASS_RATIO,
  );
  // A HIGH known-red is excused only when the incumbent shares it; without a
  // baseline that cannot be checked, so it is reported as unverified (➖)
  // rather than as a miss — consistent with the parity check below. The
  // harness tags knownIssue only on a failed case, so a passed-by-majority
  // case below the ratio never carries one and is always a miss.
  const highMisses = highBelowBar
    .filter(
      ([r, c]) =>
        !c.knownIssue ||
        (baseline !== undefined && !baseline.knownRedCaseIds.includes(caseKey(r, c))),
    )
    .map(([r, c]) => caseRef(r, c));
  const highUnverified = highBelowBar
    .filter(([, c]) => c.knownIssue && baseline === undefined)
    .map(([r, c]) => caseRef(r, c));
  const highTotal = cases.filter(([, c]) => c.severity === "high").length;
  bar.push({
    id: "high-pass-ratio",
    label: `every HIGH case passes, or ≥ ${Math.round(HIGH_PASS_RATIO * 5)}/5 of its samples`,
    ok: input.mock
      ? null
      : highMisses.length > 0
        ? false
        : highUnverified.length > 0
          ? null
          : true,
    detail: input.mock
      ? "structural run; assertions were not evaluated"
      : highMisses.length > 0
        ? `missed: ${highMisses.join(", ")}`
        : highUnverified.length > 0
          ? `known-red, unverified without --baseline: ${highUnverified.join(", ")}`
          : `${highTotal} high cases within tolerance`,
  });

  const candidateKnownRed = cases
    .filter(([, c]) => !c.passed && c.knownIssue)
    .map(([r, c]) => ({ ref: caseRef(r, c), key: caseKey(r, c), issue: c.knownIssue! }));
  if (input.mock) {
    bar.push({
      id: "known-red-parity",
      label: "no known-red on the candidate that is not also known-red on the incumbent",
      ok: null,
      detail: "structural run; assertions were not evaluated",
    });
  } else if (!baseline) {
    bar.push({
      id: "known-red-parity",
      label: "no known-red on the candidate that is not also known-red on the incumbent",
      ok: null,
      detail:
        candidateKnownRed.length === 0
          ? "no known-red on the candidate (no --baseline supplied)"
          : `unverified without --baseline: ${candidateKnownRed.map((k) => `${k.ref} ${k.issue}`).join(", ")}`,
    });
  } else {
    const newlyRed = candidateKnownRed.filter(
      (k) => !baseline.knownRedCaseIds.includes(k.key),
    );
    bar.push({
      id: "known-red-parity",
      label: `no known-red on the candidate that is not also known-red on ${baseline.modelId}`,
      ok: newlyRed.length === 0,
      detail:
        newlyRed.length === 0
          ? `${candidateKnownRed.length} known-red, all shared with ${baseline.modelId}`
          : `red only on the candidate: ${newlyRed.map((k) => `${k.ref} ${k.issue}`).join(", ")}`,
    });
  }

  const baselineCost = baseline?.generationCostUsd;
  if (input.mock || baselineCost === undefined || baselineCost <= 0) {
    bar.push({
      id: "cost-tripwire",
      label: `candidate generation spend ≤ ${COST_TRIPWIRE_MULTIPLIER}× the incumbent`,
      ok: null,
      detail: input.mock
        ? "structural run; no spend"
        : `candidate ~$${input.generationCostUsd.toFixed(4)}; no priced --baseline to compare`,
    });
  } else {
    const ratio = input.generationCostUsd / baselineCost;
    bar.push({
      id: "cost-tripwire",
      label: `candidate generation spend ≤ ${COST_TRIPWIRE_MULTIPLIER}× ${baseline!.modelId}`,
      ok: ratio <= COST_TRIPWIRE_MULTIPLIER,
      detail: `~$${input.generationCostUsd.toFixed(4)} vs ~$${baselineCost.toFixed(4)} (${ratio.toFixed(2)}×)`,
    });
  }

  const verdict = bar.some((b) => b.ok === false)
    ? "not-qualified"
    : bar.some((b) => b.ok === null)
      ? "incomplete"
      : "qualified";

  return {
    candidateModelId: input.candidateModelId,
    judgeModelId: input.judgeModelId,
    ...(baseline ? { baselineModelId: baseline.modelId } : {}),
    mock: input.mock,
    suites: scoreSuites(results),
    bar,
    verdict,
  };
}

/** Markdown rendering shared by the terminal summary and the report. */
export function renderScorecard(card: Scorecard): string {
  const icon = (ok: boolean | null) => (ok === null ? "➖" : ok ? "✅" : "❌");
  const sev = (s: SuiteScore, key: EvalSeverity) => {
    const { passed, failed } = s.bySeverity[key];
    return passed + failed === 0 ? "–" : `${passed}/${passed + failed}`;
  };
  const verdictLine =
    card.verdict === "qualified"
      ? "✅ QUALIFIED"
      : card.verdict === "not-qualified"
        ? "❌ NOT QUALIFIED"
        : "➖ INCOMPLETE (a check could not run; see below)";
  const lines = [
    `## Scorecard — candidate \`${card.candidateModelId}\` · judge \`${card.judgeModelId}\`${card.baselineModelId ? ` · baseline \`${card.baselineModelId}\`` : ""}`,
    "",
    card.mock
      ? "⚠️ --mock structural run: the table proves wiring only and can never qualify a model."
      : verdictLine,
    "",
    "| Suite | Status | Pass | Blocking | Known-red | Critical | High | Medium | Low |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...card.suites.map(
      (s) =>
        `| ${s.capability} | ${s.status === "pass" ? "✅ pass" : s.status === "known-red" ? "⚠️ known-red" : "❌ fail"} | ${s.passed} | ${s.blocking} | ${s.knownRed} | ${sev(s, "critical")} | ${sev(s, "high")} | ${sev(s, "medium")} | ${sev(s, "low")} |`,
    ),
    "",
    "Qualification bar:",
    ...card.bar.map((b) => `- ${icon(b.ok)} ${b.label} — ${b.detail}`),
  ];
  return lines.join("\n");
}

/**
 * Derive a baseline from a previous JSON report (`eval-reports/*.json`) —
 * normally the latest nightly on the default model. Tolerates reports written
 * before this module existed (no `candidateModelId` in meta).
 */
export function baselineFromReport(
  report: {
    meta?: { candidateModelId?: string; generationCostUsd?: number; mock?: boolean };
    results?: readonly CapabilityResult[];
  },
  fallbackModelId: string,
): ScorecardBaseline {
  if (report.meta?.mock) {
    throw new Error("--baseline must be a real-model report; a --mock report has no verdicts");
  }
  const results = report.results ?? [];
  return {
    modelId: report.meta?.candidateModelId ?? fallbackModelId,
    knownRedCaseIds: results.flatMap((r) =>
      r.results.filter((c) => !c.passed && c.knownIssue).map((c) => caseKey(r, c)),
    ),
    ...(typeof report.meta?.generationCostUsd === "number"
      ? { generationCostUsd: report.meta.generationCostUsd }
      : {}),
  };
}
