import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RealBedrockClient } from "@ai-workspace/agent";
import {
  CORE_DISCOVERY_TOOL_CONFIG,
  DISCOVERY_BENCHMARK_COST_CAP_USD,
  DISCOVERY_BENCHMARK_MAX_TOKENS,
  FULL_CATALOG_TOOL_CONFIG,
  approximateToolConfigTokens,
  buildDiscoveryBenchmarkPlan,
  runDiscoveryBenchmark,
  type DiscoveryBenchmarkResult,
} from "./tool-discovery";
import { median } from "./model-routing";

/**
 * #384 P4 measurement CLI. `--dry-run` prints the plan and approximate
 * tool-config sizes without touching AWS. A real run needs AWS_REGION and
 * writes eval-reports/<stamp>-discovery-benchmark.{md,json} including the
 * spec's three flip criteria evaluated against the results.
 */
async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const plan = buildDiscoveryBenchmarkPlan();
  process.stdout.write(
    [
      "Tool-discovery benchmark (#384 P4)",
      `Calls: ${plan.length} | max output ${DISCOVERY_BENCHMARK_MAX_TOKENS} tokens | cost cap $${DISCOVERY_BENCHMARK_COST_CAP_USD.toFixed(2)}`,
      `Tool config ~tokens: full-catalog ${approximateToolConfigTokens(FULL_CATALOG_TOOL_CONFIG)} (${FULL_CATALOG_TOOL_CONFIG.tools.length} tools) | core-discovery ${approximateToolConfigTokens(CORE_DISCOVERY_TOOL_CONFIG)} (${CORE_DISCOVERY_TOOL_CONFIG.tools.length} tools)`,
      "",
    ].join("\n"),
  );
  if (dryRun) return;

  if (!process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION) {
    throw new Error(
      "Discovery benchmark requires AWS_REGION or AWS_DEFAULT_REGION. Use --dry-run to inspect the plan without AWS.",
    );
  }

  const results = await runDiscoveryBenchmark(
    new RealBedrockClient(),
    (result) => {
      process.stdout.write(
        `${result.scenarioId} / ${result.promptId} / ${result.phase}: ` +
          `first=${formatMs(result.firstEventMs)} total=${formatMs(result.totalMs)} ` +
          `write=${result.cacheWriteInputTokens} read=${result.cacheReadInputTokens} ` +
          `tools=${result.toolCalls.join(",") || "none"} ok=${result.selectionCorrect}\n`,
      );
    },
  );

  const paths = writeReport(results);
  process.stdout.write(`\nReport: ${paths.markdown}\nRaw: ${paths.json}\n`);
}

interface FlipCriterion {
  name: string;
  baseline: string;
  candidate: string;
  pass: boolean;
}

function evaluateFlipCriteria(
  results: DiscoveryBenchmarkResult[],
): FlipCriterion[] {
  const rows = (
    scenarioId: DiscoveryBenchmarkResult["scenarioId"],
    filter: (row: DiscoveryBenchmarkResult) => boolean = () => true,
  ) => results.filter((row) => row.scenarioId === scenarioId && filter(row));

  const warmTtft = (scenarioId: DiscoveryBenchmarkResult["scenarioId"]) =>
    median(
      rows(scenarioId, (row) => row.phase === "warm").flatMap((row) =>
        typeof row.firstEventMs === "number" ? [row.firstEventMs] : [],
      ),
    );
  const fullTtft = warmTtft("full-catalog");
  const coreTtft = warmTtft("core-discovery");

  // The greeting tax: cold cache write on the chit-chat prompt.
  const coldGreetingWrite = (
    scenarioId: DiscoveryBenchmarkResult["scenarioId"],
  ) =>
    rows(
      scenarioId,
      (row) => row.phase === "cold" && row.promptId === "chit-chat",
    ).reduce((sum, row) => sum + row.cacheWriteInputTokens, 0);
  const fullWrite = coldGreetingWrite("full-catalog");
  const coreWrite = coldGreetingWrite("core-discovery");

  const selectionRate = (
    scenarioId: DiscoveryBenchmarkResult["scenarioId"],
  ) => {
    const scenarioRows = rows(scenarioId);
    return (
      scenarioRows.filter((row) => row.selectionCorrect).length /
      Math.max(1, scenarioRows.length)
    );
  };
  const fullSelection = selectionRate("full-catalog");
  const coreSelection = selectionRate("core-discovery");

  return [
    {
      name: "Warm TTFT (p50 first event)",
      baseline: formatMs(fullTtft),
      candidate: formatMs(coreTtft),
      pass: coreTtft !== null && fullTtft !== null && coreTtft <= fullTtft,
    },
    {
      name: "Cold greeting cache-write tokens",
      baseline: String(fullWrite),
      candidate: String(coreWrite),
      pass: coreWrite < fullWrite,
    },
    {
      name: "Tool-selection correctness",
      baseline: `${(fullSelection * 100).toFixed(0)}%`,
      candidate: `${(coreSelection * 100).toFixed(0)}%`,
      pass: coreSelection >= fullSelection,
    },
  ];
}

function writeReport(results: DiscoveryBenchmarkResult[]) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = resolve(process.cwd(), "eval-reports");
  mkdirSync(reportDir, { recursive: true });
  const base = resolve(reportDir, `${stamp}-discovery-benchmark`);
  const totalCost = results.reduce(
    (sum, result) => sum + result.estimatedCostUsd,
    0,
  );
  const criteria = evaluateFlipCriteria(results);
  const flip = criteria.every((criterion) => criterion.pass);

  writeFileSync(
    `${base}.json`,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), totalCostUsd: totalCost, criteria, flip, results }, null, 2)}\n`,
  );

  const lines = [
    `# Tool-discovery benchmark (#384 P4) ${stamp}`,
    "",
    `Calls: ${results.length} | Estimated cost: $${totalCost.toFixed(4)}`,
    "",
    "## Flip criteria (all must pass)",
    "",
    "| Criterion | Full catalog (baseline) | Core + discovery | Pass |",
    "| --- | ---: | ---: | :-: |",
    ...criteria.map(
      (criterion) =>
        `| ${criterion.name} | ${criterion.baseline} | ${criterion.candidate} | ${criterion.pass ? "✅" : "❌"} |`,
    ),
    "",
    `**Verdict: ${flip ? "FLIP — all criteria beat baseline" : "DO NOT FLIP — at least one criterion failed"}**`,
    "",
    "## Runs",
    "",
    "| Scenario | Prompt | Phase | First event | Total | Input | Cache read | Cache write | Tool calls | Correct | Cost |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | :-: | ---: |",
    ...results.map(
      (result) =>
        `| ${result.scenarioId} | ${result.promptId} | ${result.phase} | ${formatMs(result.firstEventMs)} | ${formatMs(result.totalMs)} | ${result.inputTokens} | ${result.cacheReadInputTokens} | ${result.cacheWriteInputTokens} | ${result.toolCalls.join(", ") || "none"} | ${result.selectionCorrect ? "✅" : "❌"} | $${result.estimatedCostUsd.toFixed(5)} |`,
    ),
  ];
  writeFileSync(`${base}.md`, `${lines.join("\n")}\n`);
  return { markdown: `${base}.md`, json: `${base}.json` };
}

function formatMs(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value)} ms`;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
