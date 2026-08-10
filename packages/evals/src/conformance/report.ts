import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ConformanceProbeResult,
  RuntimeConformanceReport,
} from "./types";

export function renderConformanceJson(
  report: RuntimeConformanceReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderConformanceMarkdown(
  report: RuntimeConformanceReport,
): string {
  const lane = report.provenance;
  const lines = [
    `# Runtime conformance: ${lane.lane}`,
    "",
    `- Runtime: \`${lane.runtime}\``,
    `- Model: \`${lane.modelId}\``,
    `- Mode: \`${lane.mode}\``,
    `- App version: \`${lane.appVersion}\``,
    `- Commit: \`${lane.commitSha}\``,
    `- Runtime image: \`${lane.runtimeImage}\``,
    `- Generated: ${report.finishedAt}`,
    `- Contract: ${report.gate.contractPassed ? "PASS" : "BLOCKED"}`,
    `- Production enablement: ${
      report.gate.eligibleForProduction
        ? "eligible"
        : lane.mode === "offline-contract"
          ? "not eligible from offline evidence alone"
          : "not eligible"
    }`,
    "",
    "| Probe | Requirement | Declared | Verdict | Gate | Evidence |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.results.map(renderProbeRow),
    "",
    "## Summary",
    "",
    `Supported: ${report.counts.SUPPORTED}; unsupported: ${report.counts.UNSUPPORTED}; partial: ${report.counts.PARTIAL}; unknown: ${report.counts.UNKNOWN}; skipped: ${report.counts.SKIPPED}; drift: ${report.counts.DRIFT}.`,
    "",
    `Executed ${report.budget.executedProbes}/${report.budget.maxProbes} budgeted probes at $${report.budget.observedCostUsd.toFixed(6)} observed cost (cap $${report.budget.maxCostUsd.toFixed(2)}).`,
    "",
  ];

  if (report.gate.blockingProbeIds.length > 0) {
    lines.push(
      `Blocking probes: ${report.gate.blockingProbeIds.map(code).join(", ")}.`,
      "",
    );
  }
  if (report.gate.inconclusiveProbeIds.length > 0) {
    lines.push(
      `Inconclusive probes: ${report.gate.inconclusiveProbeIds.map(code).join(", ")}.`,
      "",
    );
  }

  lines.push(
    "Offline-contract reports prove the harness and declarations are internally consistent. Only live or pre-enable reports can qualify a production lane.",
    "",
  );
  return lines.join("\n");
}

export function writeConformanceReports(
  reports: readonly RuntimeConformanceReport[],
  outputDirectory = "conformance-reports",
): string[] {
  const directory = resolve(outputDirectory);
  mkdirSync(directory, { recursive: true });
  const paths: string[] = [];
  for (const report of reports) {
    const stamp = report.finishedAt.replace(/[:.]/g, "-");
    const base = `${stamp}-${slug(report.provenance.lane)}-${slug(
      report.provenance.runtime,
    )}-${slug(report.provenance.modelId)}`;
    const jsonPath = resolve(directory, `${base}.json`);
    const markdownPath = resolve(directory, `${base}.md`);
    writeFileSync(jsonPath, renderConformanceJson(report));
    writeFileSync(markdownPath, renderConformanceMarkdown(report));
    paths.push(jsonPath, markdownPath);
  }
  return paths;
}

function renderProbeRow(result: ConformanceProbeResult): string {
  const evidence = Object.entries(result.evidence)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("; ");
  const detail = evidence ? `${result.summary} ${evidence}` : result.summary;
  return `| ${escapeCell(result.title)} | ${result.requirement} | ${result.declaration} | **${result.verdict}** | ${result.gateImpact} | ${escapeCell(detail)} |`;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function code(value: string): string {
  return `\`${value}\``;
}
