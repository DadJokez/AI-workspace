import { writeFileSync, mkdirSync } from "node:fs";
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
import { estimateUsageCostUsd } from "./benchmarks/model-routing";

const SUITES: EvalSuite[] = [
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
 * CLI entry (FR-005): `pnpm eval [capability]` runs all or one capability
 * against real Bedrock, prints a report, writes JSON+Markdown under
 * eval-reports/, and exits non-zero on any failure. `--mock` swaps the fake
 * client for a free structural-only pass (won't catch model-behavior bugs,
 * but proves the harness wiring in plain CI).
 */
async function main() {
  const args = process.argv.slice(2);
  const mock = args.includes("--mock");
  const filter = args.find((a) => !a.startsWith("--"));
  const suites = filter
    ? SUITES.filter((s) => s.capability === filter)
    : SUITES;

  if (suites.length === 0) {
    console.error(
      `No suite matches "${filter}". Available: ${SUITES.map((s) => s.capability).join(", ")}`,
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

  const options = mock
    ? { client: new FakeBedrockClient({ delayMs: 0 }), structuralOnly: true }
    : {};
  const results: CapabilityResult[] = [];
  let totalIn = 0;
  let totalOut = 0;

  for (const suite of suites) {
    process.stdout.write(`\n▶ ${suite.capability}\n`);
    const result = await runSuite(suite, options);
    results.push(result);
    for (const c of result.results) {
      totalIn += c.tokensIn;
      totalOut += c.tokensOut;
      const icon = c.errored ? "💥" : c.passed ? "✅" : "❌";
      const repeatNote =
        c.runs && c.runs > 1
          ? ` [${c.passCount ?? 0}/${c.runs} passed, ${c.passPolicy ?? "all"}]`
          : "";
      process.stdout.write(`  ${icon} ${c.caseId}${repeatNote} — ${c.description}\n`);
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
  const approxCostUsd = results.reduce(
    (suiteTotal, result) =>
      suiteTotal +
      result.results.reduce(
        (caseTotal, testCase) =>
          caseTotal + estimateUsageCostUsd(testCase.modelId, testCase),
        0,
      ),
    0,
  );

  process.stdout.write(
    `\n${totalFailed === 0 ? "✅" : "❌"} ${totalPassed} passed, ${totalFailed} failed · ` +
      `${totalIn}+${totalOut} tokens · ~$${approxCostUsd.toFixed(4)}${mock ? " (mock)" : ""}\n`,
  );

  writeReport(results, { mock, totalIn, totalOut, approxCostUsd });
  process.exit(totalFailed === 0 ? 0 : 1);
}

function writeReport(
  results: CapabilityResult[],
  meta: { mock: boolean; totalIn: number; totalOut: number; approxCostUsd: number },
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
    `~$${meta.approxCostUsd.toFixed(4)} · ${meta.totalIn}+${meta.totalOut} tokens`,
    "",
  ];
  for (const r of results) {
    md.push(`## ${r.capability} — ${r.passed}/${r.passed + r.failed} passed`, "");
    for (const c of r.results) {
      md.push(`- ${c.passed ? "✅" : c.errored ? "💥" : "❌"} **${c.caseId}** — ${c.description}`);
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
      }
    }
    md.push("");
  }
  writeFileSync(`${base}.md`, md.join("\n"));
  process.stdout.write(`\n📄 report: ${base}.md\n`);
}

void main();
