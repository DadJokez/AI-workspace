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
import { estimateUsageCostUsd } from "./benchmarks/model-routing";
import { JUDGE_MODEL_ID } from "./judge";

export const SUITES: EvalSuite[] = [
  foundationalChatSuite,
  fileResourceGroundingSuite,
  artifactOutputHonestySuite,
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

/** Select a capability and/or the stable foundational `core` case tag. */
export function selectSuites(
  args: readonly string[],
  availableSuites: readonly EvalSuite[] = SUITES,
): EvalSuite[] {
  const core = args.includes("--core");
  const filter = args.find((arg) => !arg.startsWith("--"));
  return availableSuites
    .filter((suite) => !filter || suite.capability === filter)
    .map((suite) => {
      if (!core) return suite;
      const suiteIsCore = suite.tags?.includes("core") ?? false;
      return {
        ...suite,
        cases: suite.cases.filter(
          (testCase) =>
            suiteIsCore || (testCase.tags?.includes("core") ?? false),
        ),
      };
    })
    .filter((suite) => suite.cases.length > 0);
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
  const core = args.includes("--core");
  const filter = args.find((a) => !a.startsWith("--"));
  const suites = selectSuites(args);

  if (suites.length === 0) {
    console.error(
      filter
        ? `No ${core ? "core-tagged " : ""}suite matches "${filter}". Available: ${SUITES.map((s) => s.capability).join(", ")}`
        : "No core-tagged eval cases are configured.",
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
  if (core) {
    const count = suites.reduce((total, suite) => total + suite.cases.length, 0);
    console.log(
      `🎯 --core: ${count} foundational cases across ${suites.length} suites.\n`,
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
      const icon = c.errored ? "💥" : c.passed ? "✅" : "❌";
      const repeatNote =
        c.runs && c.runs > 1
          ? ` [${c.passCount ?? 0}/${c.runs} passed, ${c.passPolicy ?? "all"}]`
          : "";
      process.stdout.write(
        `  ${icon} [${c.severity.toUpperCase()}] ${c.caseId}${repeatNote} — ${c.description}\n`,
      );
      if (c.errored) {
        process.stdout.write(`       error: ${c.errored}\n`);
      } else if (!c.passed) {
        process.stdout.write(`       debug: thread=${c.threadId} run=${c.runId}\n`);
        for (const a of c.assertions.filter((x) => !x.ok)) {
          process.stdout.write(
            `       ✗ ${a.label}${a.detail ? ` — ${a.detail}` : ""}\n`,
          );
        }
        process.stdout.write(`       answer: ${c.answerPreview}\n`);
      }
      if (c.toolCalls.length > 0) {
        process.stdout.write(`       tools: ${c.toolCalls.join(", ")}\n`);
      }
    }
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
    `\n${totalFailed === 0 ? "✅" : "❌"} ${totalPassed} passed, ${totalFailed} failed · ` +
      `${totalIn}+${totalOut} tokens · ~$${approxCostUsd.toFixed(4)}${mock ? " (mock)" : ""}\n`,
  );
  if (totalJudgeIn > 0 || totalJudgeOut > 0) {
    process.stdout.write(
      `   judge: ${totalJudgeIn}+${totalJudgeOut} tokens · ~$${judgeCostUsd.toFixed(4)}\n`,
    );
  }

  writeReport(results, {
    mock,
    core,
    totalIn,
    totalOut,
    totalJudgeIn,
    totalJudgeOut,
    generationCostUsd,
    judgeCostUsd,
    approxCostUsd,
  });
  process.exit(totalFailed === 0 ? 0 : 1);
}

function writeReport(
  results: CapabilityResult[],
  meta: {
    mock: boolean;
    core: boolean;
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
    `Selection: ${meta.core ? "core-tagged foundational cases" : "full suite"}`,
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
        `- ${c.passed ? "✅" : c.errored ? "💥" : "❌"} **[${c.severity.toUpperCase()}] ${c.caseId}** — ${c.description}`,
      );
      md.push(`  - Tags: ${c.tags.join(", ") || "(none)"}`);
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
          md.push(`  - ✗ ${a.label}${a.detail ? ` — ${a.detail}` : ""}`);
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
