import { execFileSync } from "node:child_process";
import { DEFAULT_MODEL_ID } from "@ai-workspace/agent";
import { OfflineContractDriver } from "./fixtures";
import { writeConformanceReports } from "./report";
import { runRuntimeConformance } from "./runner";
import type { ConformanceLaneProvenance } from "./types";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--live")) {
    process.stderr.write(
      "Live conformance is not enabled until #706 isolates eval quota from production. Run the offline contract with --offline.\n",
    );
    process.exitCode = 2;
    return;
  }
  if (args.length > 0 && !args.every((arg) => arg === "--offline")) {
    process.stderr.write(`Unknown conformance option: ${args.join(" ")}\n`);
    process.exitCode = 2;
    return;
  }

  const commitSha = resolveCommitSha();
  const appVersion = process.env.COMPARATIVE_APP_VERSION ?? "0.1.0";
  const common = {
    mode: "offline-contract" as const,
    modelId: DEFAULT_MODEL_ID,
    appVersion,
    commitSha,
    runtimeImage:
      process.env.RUNTIME_IMAGE_DIGEST ?? `source:${commitSha}`,
    environment: "ci",
  };
  const lanes: ConformanceLaneProvenance[] = [
    { ...common, lane: "fast-local", runtime: "bedrock" },
    { ...common, lane: "tool-local", runtime: "bedrock" },
    { ...common, lane: "durable-local", runtime: "agentcore" },
  ];
  const reports = [];
  for (const provenance of lanes) {
    reports.push(
      await runRuntimeConformance(
        new OfflineContractDriver({ provenance }),
        { maxCostUsd: 0 },
      ),
    );
  }

  const paths = writeConformanceReports(reports);
  for (const report of reports) {
    process.stdout.write(
      `${report.gate.contractPassed ? "PASS" : "BLOCKED"} ${report.provenance.lane} (${report.provenance.runtime}/${report.provenance.modelId}): ` +
        `${report.counts.SUPPORTED} supported, ${report.counts.UNSUPPORTED} explicitly unsupported, ${report.counts.DRIFT} drift\n`,
    );
  }
  process.stdout.write(`Wrote ${paths.length} report files.\n`);
  process.exitCode = reports.every((report) => report.gate.contractPassed)
    ? 0
    : 1;
}

function resolveCommitSha(): string {
  if (process.env.GITHUB_SHA?.trim()) return process.env.GITHUB_SHA.trim();
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

void main();
