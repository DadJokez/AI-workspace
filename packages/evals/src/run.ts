import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeBedrockClient } from "@ai-workspace/agent";
import { runSuite } from "./harness";
import type { CapabilityResult, EvalSuite } from "./types";
import { contextFaithfulnessSuite } from "./cases/context-faithfulness.cases";
import { dateGroundingSuite } from "./cases/date-grounding.cases";
import { gmailCalendarFaithfulnessSuite } from "./cases/gmail-calendar-faithfulness.cases";
import { salesforceFaithfulnessSuite } from "./cases/salesforce-faithfulness.cases";
import { skillFaithfulnessSuite } from "./cases/skill-faithfulness.cases";
import { toolGroundingSuite } from "./cases/tool-grounding.cases";
import { webSearchFaithfulnessSuite } from "./cases/web-search-faithfulness.cases";
import { webFetchFaithfulnessSuite } from "./cases/web-fetch-faithfulness.cases";
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
import { estimateUsageCostUsd } from "./benchmarks/model-routing";
import { JUDGE_MODEL_ID } from "./judge";

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
  modelRoutingSuite,
  toolDiscoverySuite,
  attachmentInjectionSuite,
  mcpInjectionSuite,
  githubContentInjectionSuite,
  memoryInjectionSuite,
  toolEvidenceContinuitySuite,
];

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
  const tag = args.includes("--gate")
    ? "gate"
    : args.includes("--core")
      ? "core"
      : undefined;
  const filter = args.find((arg) => !arg.startsWith("--"));
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
 * CLI entry (FR-005): `pnpm eval [capability]` runs all or one capability
 * against real Bedrock, prints a report, writes JSON+Markdown under
 * eval-reports/, and exits non-zero on any failure. `--mock` swaps the fake
 * client for a free structural-only pass (won't catch model-behavior bugs,
 * but proves the harness wiring in plain CI).
 */
async function main() {
  const args = process.argv.slice(2);
  const mock = args.includes("--mock");
  const gate = args.includes("--gate");
  const core = args.includes("--core");
  const packName = gate ? "gate" : core ? "core" : undefined;
  const filter = args.find((a) => !a.startsWith("--"));
  const suites = selectSuites(args);

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
      const icon = c.errored ? "💥" : c.passed ? "✅" : c.knownIssue ? "⚠️" : "❌";
      const repeatNote =
        c.runs && c.runs > 1
          ? ` [${c.passCount ?? 0}/${c.runs} passed, ${c.passPolicy ?? "all"}]`
          : "";
      const knownNote =
        !c.passed && c.knownIssue ? ` [KNOWN ${c.knownIssue}, non-blocking]` : "";
      process.stdout.write(
        `  ${icon} [${c.severity.toUpperCase()}] ${c.caseId}${repeatNote}${knownNote} — ${c.description}\n`,
      );
      if (c.errored) {
        process.stdout.write(`       error: ${c.errored}\n`);
      } else if (!c.passed) {
        process.stdout.write(`       debug: thread=${c.threadId} run=${c.runId}\n`);
        for (const a of c.assertions.filter((x) => !x.ok)) {
          process.stdout.write(
            `       ✗ ${a.label}${a.knownIssue ? ` [known ${a.knownIssue}]` : ""}${a.detail ? ` — ${a.detail}` : ""}\n`,
          );
        }
        process.stdout.write(`       answer: ${c.answerPreview}\n`);
      }
      if (c.toolCalls.length > 0) {
        process.stdout.write(`       tools: ${c.toolCalls.join(", ")}\n`);
      }
    }
  }

  const outcome = summarizeOutcome(results);
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

  writeReport(results, {
    mock,
    core,
    gate,
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
  meta: {
    mock: boolean;
    core: boolean;
    gate: boolean;
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

  writeFileSync(`${base}.json`, JSON.stringify({ meta, results }, null, 2));

  const md: string[] = [
    `# Eval report ${stamp}${meta.mock ? " (mock)" : ""}`,
    "",
    `~$${meta.approxCostUsd.toFixed(4)} total (${meta.generationCostUsd.toFixed(4)} candidate + ${meta.judgeCostUsd.toFixed(4)} judge)`,
    "",
    `Candidate tokens: ${meta.totalIn}+${meta.totalOut} · judge tokens: ${meta.totalJudgeIn}+${meta.totalJudgeOut}`,
    "",
    `Selection: ${meta.gate ? "gate-tagged merge-gate pack" : meta.core ? "core-tagged foundational cases" : "full suite"}`,
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
          md.push(
            `  - ✗ ${a.label}${a.knownIssue ? ` [known ${a.knownIssue}]` : ""}${a.detail ? ` — ${a.detail}` : ""}`,
          );
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
