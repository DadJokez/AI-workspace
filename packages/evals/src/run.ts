import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MODEL_ID,
  FakeBedrockClient,
  MODEL_IDS,
  MODELS,
  isValidModelId,
  type ModelId,
} from "@ai-workspace/agent";
import { runSuite } from "./harness";
import {
  type Scorecard,
  type ScorecardBaseline,
  baselineFromReport,
  buildScorecard,
  renderScorecard,
} from "./scorecard";
import type { AssertionResult, CapabilityResult, CaseResult, EvalSuite } from "./types";
import { contextFaithfulnessSuite } from "./cases/context-faithfulness.cases";
import { dateGroundingSuite } from "./cases/date-grounding.cases";
import { gmailCalendarFaithfulnessSuite } from "./cases/gmail-calendar-faithfulness.cases";
import { salesforceFaithfulnessSuite } from "./cases/salesforce-faithfulness.cases";
import { skillFaithfulnessSuite } from "./cases/skill-faithfulness.cases";
import { toolGroundingSuite } from "./cases/tool-grounding.cases";
import { webSearchFaithfulnessSuite } from "./cases/web-search-faithfulness.cases";
import { webFetchFaithfulnessSuite } from "./cases/web-fetch-faithfulness.cases";
import { webResearchArtifactSuite } from "./cases/web-research-artifact.cases";
import { modelRoutingSuite } from "./cases/model-routing.cases";
import { toolDiscoverySuite } from "./cases/tool-discovery.cases";
import { attachmentInjectionSuite } from "./cases/attachment-injection.cases";
import { mcpInjectionSuite } from "./cases/mcp-injection.cases";
import { githubContentInjectionSuite } from "./cases/github-content-injection.cases";
import { memoryInjectionSuite } from "./cases/memory-injection.cases";
import { toolEvidenceContinuitySuite } from "./cases/tool-evidence-continuity.cases";
import { foundationalChatSuite } from "./cases/foundational-chat.cases";
import { fileResourceGroundingSuite } from "./cases/file-resource-grounding.cases";
import { artifactOutputHonestySuite } from "./cases/artifact-output-honesty.cases";
import { exactOutputSuite } from "./cases/exact-output.cases";
import { threadSummaryInjectionSuite } from "./cases/thread-summary-injection.cases";
import { threadSummaryPrecedenceSuite } from "./cases/thread-summary-precedence.cases";
import { estimateUsageCostUsd } from "./benchmarks/model-routing";
import { JUDGE_INCONCLUSIVE_NOTE, JUDGE_MODEL_ID } from "./judge";

export const SUITES: EvalSuite[] = [
  foundationalChatSuite,
  fileResourceGroundingSuite,
  artifactOutputHonestySuite,
  exactOutputSuite,
  dateGroundingSuite,
  skillFaithfulnessSuite,
  contextFaithfulnessSuite,
  toolGroundingSuite,
  gmailCalendarFaithfulnessSuite,
  salesforceFaithfulnessSuite,
  webSearchFaithfulnessSuite,
  webFetchFaithfulnessSuite,
  webResearchArtifactSuite,
  modelRoutingSuite,
  toolDiscoverySuite,
  attachmentInjectionSuite,
  mcpInjectionSuite,
  githubContentInjectionSuite,
  memoryInjectionSuite,
  toolEvidenceContinuitySuite,
  threadSummaryInjectionSuite,
  threadSummaryPrecedenceSuite,
];

export interface RunArgs {
  mock: boolean;
  gate: boolean;
  core: boolean;
  /** Optional capability filter (the first bare positional). */
  filter?: string;
  /** `--model <id>`: candidate model override for every suite (#797 P2). */
  modelId?: string;
  /** `--baseline <report.json>`: incumbent report the scorecard compares to. */
  baselinePath?: string;
}

/**
 * Parse the CLI. Value-taking flags (`--model x` / `--model=x`) consume their
 * value so it is never mistaken for the capability filter.
 */
export function parseRunArgs(args: readonly string[]): RunArgs {
  const valued = new Set(["--model", "--baseline"]);
  const values: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    if (valued.has(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
      if (!value || value.startsWith("--")) {
        throw new Error(
          `${name} needs a value (e.g. ${name} ${name === "--model" ? "<registry id>" : "eval-reports/<stamp>.json"})`,
        );
      }
      values[name] = value;
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }
  return {
    mock: args.includes("--mock"),
    gate: args.includes("--gate"),
    core: args.includes("--core"),
    ...(positional[0] ? { filter: positional[0] } : {}),
    ...(values["--model"] ? { modelId: values["--model"] } : {}),
    ...(values["--baseline"] ? { baselinePath: values["--baseline"] } : {}),
  };
}

/**
 * Which model is under test and which one judges it (#797 P2). The candidate
 * comes from `--model` (default: the product default); the judge is ALWAYS
 * `JUDGE_MODEL_ID` — it never follows `--model`, and a candidate equal to the
 * judge is refused outright so a scorecard can never be a model grading
 * itself. Unknown ids are refused against the registry with the valid list.
 */
export function resolveRunModels(
  args: Pick<RunArgs, "modelId">,
): { candidateModelId: ModelId; judgeModelId: ModelId } {
  const requested = args.modelId;
  if (requested !== undefined && !isValidModelId(requested)) {
    throw new Error(
      `Unknown --model "${requested}". Registered ids: ${MODEL_IDS.join(", ")} (packages/agent/src/models.ts).`,
    );
  }
  if (requested === JUDGE_MODEL_ID) {
    throw new Error(
      `Refusing --model ${requested}: it is the pinned judge (JUDGE_MODEL_ID). A model must never qualify itself; pick a different candidate or change the judge in packages/evals/src/judge.ts.`,
    );
  }
  // No --model: the incumbent run. It is NOT refused when the default happens
  // to equal the judge (PLATFORM_MODEL_OVERRIDE_ID pins can do that) because
  // the nightly and CI mock lanes must keep running — the header and the
  // scorecard's judge-independence check say so loudly instead.
  return { candidateModelId: requested ?? DEFAULT_MODEL_ID, judgeModelId: JUDGE_MODEL_ID };
}

/**
 * Point every suite — and every case-level `modelId` pin — at the candidate.
 * Pins are overridden too: a qualification run that silently kept a handful
 * of cases on the incumbent would grade the wrong model. Returns how many
 * pins were overridden so the header can say so.
 */
export function applyModelOverride(
  suites: readonly EvalSuite[],
  candidateModelId: ModelId,
): { suites: EvalSuite[]; overriddenPins: number } {
  let overriddenPins = 0;
  const overridden = suites.map((suite) => ({
    ...suite,
    defaultModelId: candidateModelId,
    cases: suite.cases.map((testCase) => {
      if (testCase.modelId === undefined || testCase.modelId === candidateModelId) {
        return testCase;
      }
      overriddenPins += 1;
      const { modelId: _pinned, ...rest } = testCase;
      return rest;
    }),
  }));
  return { suites: overridden, overriddenPins };
}

/**
 * Select a capability and/or a tag-defined pack. `--core` is the broad
 * foundational pack (nightly). `--gate` is the merge-gate pack: the
 * security/injection spine, where every case is either repeat-sampled or
 * proven stable — a required PR check must not be a per-sample lottery
 * (~70 single-sample cases at ~99% each ≈ a 60% lane pass rate, observed
 * 2026-07-25). Single-sample behavioral coverage belongs to the nightly
 * full pack, which files eval-regression issues.
 */
export function selectSuites(
  args: readonly string[],
  availableSuites: readonly EvalSuite[] = SUITES,
): EvalSuite[] {
  const { gate, core, filter } = parseRunArgs(args);
  const tag = gate ? "gate" : core ? "core" : undefined;
  return availableSuites
    .filter((suite) => !filter || suite.capability === filter)
    .map((suite) => {
      if (!tag) return suite;
      const suiteTagged = suite.tags?.includes(tag) ?? false;
      return {
        ...suite,
        cases: suite.cases.filter(
          (testCase) =>
            suiteTagged || (testCase.tags?.includes(tag) ?? false),
        ),
      };
    })
    .filter((suite) => suite.cases.length > 0);
}

/**
 * Split failures into blocking vs. known (#675): a failed case that carries
 * `knownIssue` is reported loudly but does not fail the run — a tracked
 * permanently-red case must not make every gate a coin flip. Exported for
 * tests; the assertions themselves are never weakened by this split.
 */
export function summarizeOutcome(results: readonly CapabilityResult[]): {
  passed: number;
  blockingFailed: number;
  knownFailed: Array<{ caseId: string; knownIssue: string }>;
  exitCode: 0 | 1;
} {
  const cases = results.flatMap((r) => r.results);
  const passed = cases.filter((c) => c.passed).length;
  const failed = cases.filter((c) => !c.passed);
  const knownFailed = failed
    .filter((c) => c.knownIssue)
    .map((c) => ({ caseId: c.caseId, knownIssue: c.knownIssue! }));
  const blockingFailed = failed.length - knownFailed.length;
  return { passed, blockingFailed, knownFailed, exitCode: blockingFailed === 0 ? 0 : 1 };
}

/**
 * A failed assertion's label, saying so when the failure is an inconclusive
 * judge sample rather than a rubric FAIL (#895). Shared by every rendering so
 * the wording is identical in the summary, the report and the CI output.
 */
function failedAssertionLabel(a: AssertionResult): string {
  return a.inconclusive ? `${a.label} — ${JUDGE_INCONCLUSIVE_NOTE}` : a.label;
}

/** The `✗` line for a failed assertion: label, known-issue marker, detail. */
function describeFailedAssertion(a: AssertionResult): string {
  return `${failedAssertionLabel(a)}${a.knownIssue ? ` [known ${a.knownIssue}]` : ""}${a.detail ? ` — ${a.detail}` : ""}`;
}

/** The per-case summary line printed as the run progresses. */
export function formatCaseSummary(c: CaseResult): string {
  const icon = c.errored ? "💥" : c.passed ? "✅" : c.knownIssue ? "⚠️" : "❌";
  const repeatNote =
    c.runs && c.runs > 1
      ? ` [${c.passCount ?? 0}/${c.runs} passed, ${c.passPolicy ?? "all"}]`
      : "";
  const inconclusiveNote = c.inconclusiveRuns
    ? ` [${c.inconclusiveRuns} ${JUDGE_INCONCLUSIVE_NOTE}]`
    : "";
  const knownNote =
    !c.passed && c.knownIssue ? ` [KNOWN ${c.knownIssue}, non-blocking]` : "";
  return `${icon} [${c.severity.toUpperCase()}] ${c.caseId}${repeatNote}${inconclusiveNote}${knownNote} — ${c.description}`;
}

/**
 * One-line CI outputs (#847) so the nightly regression comment can name the
 * failing case instead of just "failure". `failingCases` lists blocking
 * failures as `capability/caseId [passCount/runs]: <failing labels>`;
 * `knownCases` lists the known-red, non-blocking ones. Newlines are stripped
 * (GITHUB_OUTPUT is line-delimited) and the blocking list is capped.
 */
export function formatCiOutcome(results: readonly CapabilityResult[]): {
  failingCases: string;
  knownCases: string;
} {
  const oneLine = (text: string) => text.replace(/\s*[\r\n]+\s*/g, " ").trim();
  const failingCases = results
    .flatMap((r) =>
      r.results
        .filter((c) => !c.passed && !c.knownIssue)
        .map((c) => {
          const labels = c.assertions.filter((a) => !a.ok).map(failedAssertionLabel);
          if (c.errored) labels.push(`error: ${c.errored}`);
          const inconclusive = c.inconclusiveRuns
            ? `, ${c.inconclusiveRuns} ${JUDGE_INCONCLUSIVE_NOTE}`
            : "";
          return `${r.capability}/${c.caseId} [${c.passCount ?? 0}/${c.runs ?? 1}${inconclusive}]: ${labels.join("; ")}`;
        }),
    )
    .join(" | ");
  const knownCases = summarizeOutcome(results)
    .knownFailed.map((k) => `${k.caseId} ${k.knownIssue}`)
    .join("; ");
  return {
    failingCases: oneLine(failingCases).slice(0, 2000),
    knownCases: oneLine(knownCases),
  };
}

/**
 * CLI entry (FR-005): `pnpm eval [capability]` runs all or one capability
 * against real Bedrock, prints a report, writes JSON+Markdown under
 * eval-reports/, and exits non-zero on any failure. `--mock` swaps the fake
 * client for a free structural-only pass (won't catch model-behavior bugs,
 * but proves the harness wiring in plain CI). `--model <id>` runs the same
 * pack against a candidate model and renders the qualification scorecard
 * (#797 P2); `--baseline <report.json>` supplies the incumbent run to
 * compare known-red and spend against.
 */
async function main() {
  const args = process.argv.slice(2);
  let parsed: RunArgs;
  let models: ReturnType<typeof resolveRunModels>;
  let baseline: ScorecardBaseline | undefined;
  try {
    parsed = parseRunArgs(args);
    models = resolveRunModels(parsed);
    if (parsed.baselinePath) {
      baseline = baselineFromReport(
        JSON.parse(readFileSync(parsed.baselinePath, "utf8")),
        DEFAULT_MODEL_ID,
      );
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  const { mock, gate, core, filter } = parsed;
  const { candidateModelId, judgeModelId } = models;
  const packName = gate ? "gate" : core ? "core" : undefined;
  const selected = selectSuites(args);
  const { suites, overriddenPins } = parsed.modelId
    ? applyModelOverride(selected, candidateModelId)
    : { suites: selected, overriddenPins: 0 };

  if (suites.length === 0) {
    console.error(
      filter
        ? `No ${packName ? `${packName}-tagged ` : ""}suite matches "${filter}". Available: ${SUITES.map((s) => s.capability).join(", ")}`
        : `No ${packName ?? "matching"}-tagged eval cases are configured.`,
    );
    process.exit(2);
  }

  if (mock) {
    console.log("⚠️  --mock: structural run only; model-behavior bugs WILL pass.\n");
  } else if (!process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION) {
    console.error(
      "Real-model eval needs AWS_REGION (or --mock). Refusing to run blind.",
    );
    process.exit(2);
  } else if ((process.env.BEDROCK_CLIENT ?? "fake").toLowerCase() !== "real") {
    // getBedrockClient() defaults to the fake client, which would produce a
    // real-looking report that never touched a model. Refuse, same as above.
    console.error(
      "Real-model eval needs BEDROCK_CLIENT=real (or --mock). Refusing to run the fake client as if it were real.",
    );
    process.exit(2);
  }
  if (packName) {
    const count = suites.reduce((total, suite) => total + suite.cases.length, 0);
    console.log(
      `🎯 --${packName}: ${count} ${gate ? "merge-gate" : "foundational"} cases across ${suites.length} suites.\n`,
    );
  }
  // Both ids in the header so a transcript can never leave it ambiguous who
  // graded whom; the judge line is deliberately independent of --model.
  console.log(
    `🧠 candidate: ${candidateModelId} (${MODELS[candidateModelId].displayName}, ${MODELS[candidateModelId].provider})` +
      (parsed.modelId
        ? ` — --model overrides every suite default${overriddenPins > 0 ? ` and ${overriddenPins} case-level pin(s)` : ""}`
        : "") +
      `\n⚖️  judge: ${judgeModelId} (${MODELS[judgeModelId].displayName}; pinned, never follows --model)` +
      (candidateModelId === judgeModelId
        ? `\n🚨 candidate and judge are the SAME model (the default is pinned to the judge) — judge verdicts in this run are self-graded; not a qualification run`
        : "") +
      (baseline
        ? `\n📐 baseline: ${baseline.modelId} from ${parsed.baselinePath} (${baseline.knownRedCaseIds.length} known-red)`
        : "") +
      "\n",
  );

  const options = mock
    ? { client: new FakeBedrockClient({ delayMs: 0 }), structuralOnly: true }
    : {};
  const results: CapabilityResult[] = [];
  let totalIn = 0;
  let totalOut = 0;
  let totalJudgeIn = 0;
  let totalJudgeOut = 0;

  for (const suite of suites) {
    process.stdout.write(`\n▶ ${suite.capability}\n`);
    const result = await runSuite(suite, options);
    results.push(result);
    for (const c of result.results) {
      totalIn += c.tokensIn;
      totalOut += c.tokensOut;
      totalJudgeIn += c.judgeUsage.tokensIn;
      totalJudgeOut += c.judgeUsage.tokensOut;
      process.stdout.write(`  ${formatCaseSummary(c)}\n`);
      if (c.errored) {
        process.stdout.write(`       error: ${c.errored}\n`);
      } else if (!c.passed) {
        process.stdout.write(`       debug: thread=${c.threadId} run=${c.runId}\n`);
        for (const a of c.assertions.filter((x) => !x.ok)) {
          process.stdout.write(`       ✗ ${describeFailedAssertion(a)}\n`);
        }
        process.stdout.write(`       answer: ${c.answerPreview}\n`);
      }
      if (c.toolCalls.length > 0) {
        process.stdout.write(`       tools: ${c.toolCalls.join(", ")}\n`);
      }
    }
  }

  const outcome = summarizeOutcome(results);
  if (process.env.GITHUB_OUTPUT) {
    const ci = formatCiOutcome(results);
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `failing_cases=${ci.failingCases}\nknown_cases=${ci.knownCases}\n`,
    );
  }
  const totalPassed = results.reduce((n, r) => n + r.passed, 0);
  const totalFailed = results.reduce((n, r) => n + r.failed, 0);
  const generationCostUsd = results.reduce(
    (suiteTotal, result) =>
      suiteTotal +
      result.results.reduce(
        (caseTotal, testCase) =>
          caseTotal + estimateUsageCostUsd(testCase.modelId, testCase),
        0,
      ),
    0,
  );
  const judgeCostUsd = results.reduce(
    (suiteTotal, result) =>
      suiteTotal +
      result.results.reduce(
        (caseTotal, testCase) =>
          caseTotal +
          estimateUsageCostUsd(JUDGE_MODEL_ID, testCase.judgeUsage),
        0,
      ),
    0,
  );
  const approxCostUsd = generationCostUsd + judgeCostUsd;

  process.stdout.write(
    `\n${outcome.exitCode === 0 ? (totalFailed === 0 ? "✅" : "⚠️") : "❌"} ${totalPassed} passed, ` +
      `${outcome.blockingFailed} failed` +
      (outcome.knownFailed.length > 0
        ? `, ${outcome.knownFailed.length} known-red (${outcome.knownFailed
            .map((k) => `${k.caseId} ${k.knownIssue}`)
            .join("; ")})`
        : "") +
      ` · ${totalIn}+${totalOut} tokens · ~$${approxCostUsd.toFixed(4)}${mock ? " (mock)" : ""}\n`,
  );
  if (totalJudgeIn > 0 || totalJudgeOut > 0) {
    process.stdout.write(
      `   judge: ${totalJudgeIn}+${totalJudgeOut} tokens · ~$${judgeCostUsd.toFixed(4)}\n`,
    );
  }

  const scorecard = buildScorecard({
    candidateModelId,
    judgeModelId,
    results,
    mock,
    generationCostUsd,
    ...(baseline ? { baseline } : {}),
  });
  process.stdout.write(`\n${renderScorecard(scorecard)}\n`);

  writeReport(results, scorecard, {
    mock,
    core,
    gate,
    candidateModelId,
    judgeModelId,
    ...(baseline ? { baselineModelId: baseline.modelId } : {}),
    totalIn,
    totalOut,
    totalJudgeIn,
    totalJudgeOut,
    generationCostUsd,
    judgeCostUsd,
    approxCostUsd,
  });
  process.exit(outcome.exitCode);
}

function writeReport(
  results: CapabilityResult[],
  scorecard: Scorecard,
  meta: {
    mock: boolean;
    core: boolean;
    gate: boolean;
    /** Model under test (#797 P2); every case ran on it unless the run had no --model and a case pinned another. */
    candidateModelId: ModelId;
    /** Always JUDGE_MODEL_ID — recorded so a report can never hide who graded. */
    judgeModelId: ModelId;
    baselineModelId?: string;
    totalIn: number;
    totalOut: number;
    totalJudgeIn: number;
    totalJudgeOut: number;
    generationCostUsd: number;
    judgeCostUsd: number;
    approxCostUsd: number;
  },
) {
  try {
    mkdirSync("eval-reports", { recursive: true });
  } catch {
    /* ignore */
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `eval-reports/${stamp}${meta.mock ? "-mock" : ""}`;

  writeFileSync(
    `${base}.json`,
    JSON.stringify({ meta, scorecard, results }, null, 2),
  );

  const md: string[] = [
    `# Eval report ${stamp}${meta.mock ? " (mock)" : ""}`,
    "",
    `Candidate: ${meta.candidateModelId} · judge: ${meta.judgeModelId} (pinned)`,
    "",
    `~$${meta.approxCostUsd.toFixed(4)} total (${meta.generationCostUsd.toFixed(4)} candidate + ${meta.judgeCostUsd.toFixed(4)} judge)`,
    "",
    `Candidate tokens: ${meta.totalIn}+${meta.totalOut} · judge tokens: ${meta.totalJudgeIn}+${meta.totalJudgeOut}`,
    "",
    `Selection: ${meta.gate ? "gate-tagged merge-gate pack" : meta.core ? "core-tagged foundational cases" : "full suite"}`,
    "",
    renderScorecard(scorecard),
    "",
  ];
  for (const r of results) {
    const severitySummary = Object.entries(r.bySeverity)
      .filter(([, counts]) => counts.passed + counts.failed > 0)
      .map(
        ([severity, counts]) =>
          `${severity} ${counts.passed}/${counts.passed + counts.failed}`,
      )
      .join(" · ");
    md.push(
      `## ${r.capability} — ${r.passed}/${r.passed + r.failed} passed`,
      "",
      `Severity: ${severitySummary || "none"}`,
      "",
    );
    for (const c of r.results) {
      md.push(
        `- ${c.passed ? "✅" : c.errored ? "💥" : c.knownIssue ? "⚠️" : "❌"} **[${c.severity.toUpperCase()}] ${c.caseId}** — ${c.description}`,
      );
      md.push(`  - Tags: ${c.tags.join(", ") || "(none)"}`);
      if (!c.passed && c.knownIssue) {
        md.push(
          `  - ⚠️ Known-red, non-blocking: tracked in ${c.knownIssue}; assertions unchanged`,
        );
      }
      if (c.runs && c.runs > 1) {
        md.push(
          `  - Repeats: ${c.passCount ?? 0}/${c.runs} runs passed (policy: ${c.passPolicy ?? "all"})`,
        );
      }
      if (c.inconclusiveRuns) {
        md.push(
          `  - ⚠️ ${c.inconclusiveRuns} run(s) ${JUDGE_INCONCLUSIVE_NOTE}: scored not-passed, not a rubric FAIL`,
        );
      }
      md.push(`  - Debug IDs: thread=${c.threadId}; run=${c.runId}`);
      if (c.toolCalls.length > 0) {
        md.push(`  - Tool calls: ${c.toolCalls.join(", ")}`);
      }
      md.push(
        `  - Model/usage: ${c.modelId}; input=${c.inputTokens}; cache-read=${c.cacheReadInputTokens}; cache-write=${c.cacheWriteInputTokens}; output=${c.tokensOut}`,
      );
      if (c.judgeUsage.tokensIn > 0 || c.judgeUsage.tokensOut > 0) {
        md.push(
          `  - Judge/usage: ${JUDGE_MODEL_ID}; input=${c.judgeUsage.inputTokens}; cache-read=${c.judgeUsage.cacheReadInputTokens}; cache-write=${c.judgeUsage.cacheWriteInputTokens}; output=${c.judgeUsage.tokensOut}; cost=~$${estimateUsageCostUsd(JUDGE_MODEL_ID, c.judgeUsage).toFixed(6)}`,
        );
      }
      if (c.providerStatus && Object.keys(c.providerStatus).length > 0) {
        md.push(
          `  - Provider status: ${Object.entries(c.providerStatus)
            .map(([provider, status]) => `${provider}=${status}`)
            .join(", ")}`,
        );
      }
      if (c.contextReceipts.length > 0) {
        md.push(`  - Context receipts: ${c.contextReceipts.join("; ")}`);
      }
      if (c.fixtureEvidence.length > 0) {
        md.push(`  - Fixture evidence: ${c.fixtureEvidence.join("; ")}`);
      }
      for (const result of c.toolResults) {
        md.push(
          `  - Tool result ${result.toolCallId}${result.isError ? " (error)" : ""}: ${result.outputPreview}`,
        );
      }
      if (!c.passed && !c.errored) {
        for (const a of c.assertions.filter((x) => !x.ok)) {
          md.push(`  - ✗ ${describeFailedAssertion(a)}`);
        }
        md.push(
          `  - Answer preview: ${c.answerPreview.replace(/\s+/g, " ").trim() || "(empty)"}`,
        );
      }
    }
    md.push("");
  }
  writeFileSync(`${base}.md`, md.join("\n"));
  process.stdout.write(`\n📄 report: ${base}.md\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main();
}
