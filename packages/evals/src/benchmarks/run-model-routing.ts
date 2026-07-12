import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RealBedrockClient } from "@ai-workspace/agent";
import {
  ROUTING_BENCHMARK_COST_CAP_USD,
  ROUTING_BENCHMARK_MAX_CALLS,
  ROUTING_BENCHMARK_MAX_TOKENS,
  ROUTING_BENCHMARK_SCENARIOS,
  approximateStablePrefixTokens,
  buildRoutingBenchmarkPlan,
  median,
  runRoutingBenchmark,
  type RoutingBenchmarkResult,
} from "./model-routing";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const plan = buildRoutingBenchmarkPlan();
  printPlan(plan.length);
  if (dryRun) return;

  if (!process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION) {
    throw new Error(
      "Routing benchmark requires AWS_REGION or AWS_DEFAULT_REGION. Use --dry-run to inspect it without AWS.",
    );
  }

  const results = await runRoutingBenchmark(
    new RealBedrockClient(),
    (result) => {
      process.stdout.write(
        `${result.scenarioId} / ${result.promptId} / ${result.phase}: ` +
          `first=${formatMs(result.firstEventMs)} total=${formatMs(result.totalMs)} ` +
          `cacheRead=${result.cacheReadInputTokens} cacheWrite=${result.cacheWriteInputTokens} ` +
          `tools=${result.toolCalls.join(",") || "none"}\n`,
      );
    },
  );

  const reportPaths = writeReport(results);
  process.stdout.write(`\nReport: ${reportPaths.markdown}\n`);
  process.stdout.write(`Raw data: ${reportPaths.json}\n`);
}

function printPlan(callCount: number) {
  process.stdout.write(
    [
      "Model-decided routing benchmark",
      `Calls: ${callCount} (hard cap ${ROUTING_BENCHMARK_MAX_CALLS})`,
      `Max output: ${ROUTING_BENCHMARK_MAX_TOKENS} tokens per call`,
      `Observed-cost circuit breaker: $${ROUTING_BENCHMARK_COST_CAP_USD.toFixed(2)}`,
      `Approx stable prefix: tool-less ${approximateStablePrefixTokens(false)} tokens; full tools ${approximateStablePrefixTokens(true)} tokens`,
      "Matrix: 3 scenarios x 3 prompts x cold/warm",
      "",
    ].join("\n"),
  );
}

function writeReport(results: RoutingBenchmarkResult[]) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = resolve(process.cwd(), "eval-reports");
  mkdirSync(reportDir, { recursive: true });
  const base = resolve(reportDir, `${stamp}-routing-benchmark`);
  const totalCost = results.reduce(
    (sum, result) => sum + result.estimatedCostUsd,
    0,
  );
  const payload = {
    generatedAt: new Date().toISOString(),
    totalCostUsd: totalCost,
    results,
  };
  writeFileSync(`${base}.json`, `${JSON.stringify(payload, null, 2)}\n`);

  const lines = [
    `# Model-decided routing benchmark ${stamp}`,
    "",
    `Calls: ${results.length} | Estimated standard-rate cost: $${totalCost.toFixed(4)}`,
    "",
    "## Summary",
    "",
    "| Scenario | Phase | p50 first event | p50 first text | p50 total | Cache read ratio |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  ];
  for (const scenario of ROUTING_BENCHMARK_SCENARIOS) {
    for (const phase of ["cold", "warm"] as const) {
      const rows = results.filter(
        (result) =>
          result.scenarioId === scenario.id && result.phase === phase,
      );
      const inputFootprint = rows.reduce(
        (sum, row) => sum + row.tokensIn,
        0,
      );
      const cacheReads = rows.reduce(
        (sum, row) => sum + row.cacheReadInputTokens,
        0,
      );
      lines.push(
        `| ${scenario.label} | ${phase} | ${formatMs(median(numbers(rows, "firstEventMs")))} | ${formatMs(median(numbers(rows, "firstTextMs")))} | ${formatMs(median(rows.map((row) => row.totalMs)))} | ${inputFootprint > 0 ? `${((cacheReads / inputFootprint) * 100).toFixed(1)}%` : "n/a"} |`,
      );
    }
  }

  lines.push(
    "",
    "## Runs",
    "",
    "| Scenario | Prompt | Phase | First event | First text | Total | Input | Cache read | Cache write | Output | Tool calls | Cost |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |",
  );
  for (const result of results) {
    lines.push(
      `| ${result.scenarioId} | ${result.promptId} | ${result.phase} | ${formatMs(result.firstEventMs)} | ${formatMs(result.firstTextMs)} | ${formatMs(result.totalMs)} | ${result.inputTokens} | ${result.cacheReadInputTokens} | ${result.cacheWriteInputTokens} | ${result.tokensOut} | ${result.toolCalls.join(", ") || "none"} | $${result.estimatedCostUsd.toFixed(5)} |`,
    );
  }
  writeFileSync(`${base}.md`, `${lines.join("\n")}\n`);
  return { markdown: `${base}.md`, json: `${base}.json` };
}

function numbers(
  rows: RoutingBenchmarkResult[],
  key: "firstEventMs" | "firstTextMs",
): number[] {
  return rows.flatMap((row) =>
    typeof row[key] === "number" ? [row[key]] : [],
  );
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
