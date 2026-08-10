import { randomUUID } from "node:crypto";
import { CONFORMANCE_PROBES } from "./probes";
import {
  RUNTIME_CONFORMANCE_SCHEMA,
  type CapabilityDeclaration,
  type ConformanceFailureCategory,
  type ConformanceProbeDefinition,
  type ConformanceProbeExecution,
  type ConformanceProbeId,
  type ConformanceProbeResult,
  type ConformanceVerdict,
  type ProbeValidation,
  type RunConformanceOptions,
  type RuntimeConformanceDriver,
  type RuntimeConformanceReport,
} from "./types";

const DEFAULT_MAX_COST_USD = 5;

export async function runRuntimeConformance(
  driver: RuntimeConformanceDriver,
  options: RunConformanceOptions = {},
): Promise<RuntimeConformanceReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const maxProbes = Math.max(
    0,
    Math.floor(options.maxProbes ?? CONFORMANCE_PROBES.length),
  );
  const maxCostUsd = finiteNonNegative(
    options.maxCostUsd ?? DEFAULT_MAX_COST_USD,
    "maxCostUsd",
  );
  const results: ConformanceProbeResult[] = [];
  let executedProbes = 0;
  let observedCostUsd = 0;
  let exhausted = false;

  for (const probe of CONFORMANCE_PROBES) {
    const declaration = driver.declarations[probe.id];
    if (!declaration) {
      throw new Error(`Missing declaration for conformance probe ${probe.id}.`);
    }

    if (
      probe.requirement === "capability-gated" &&
      declaration.status === "unsupported"
    ) {
      results.push({
        id: probe.id,
        title: probe.title,
        requirement: probe.requirement,
        declaration: declaration.status,
        declarationSource: sanitizeText(declaration.source),
        verdict: "UNSUPPORTED",
        gateImpact: "pass",
        summary: "Capability is explicitly declared unsupported; probe was not run.",
        evidence: {},
        durationMs: 0,
        category: "unsupported",
        costUsd: 0,
      });
      continue;
    }

    if (
      exhausted ||
      executedProbes >= maxProbes ||
      observedCostUsd > maxCostUsd
    ) {
      exhausted = true;
      results.push(
        resultFromExecution(
          probe,
          declaration.status,
          declaration.source,
          {
            outcome: "skipped",
            category: "quota",
            summary: "Conformance budget was reached before this probe ran.",
          },
          0,
        ),
      );
      continue;
    }

    const probeStartedAt = now().getTime();
    let execution: ConformanceProbeExecution<ConformanceProbeId>;
    try {
      execution = await driver.runProbe(probe.id);
    } catch (error) {
      execution = {
        outcome: "failed",
        category: "harness",
        summary: error instanceof Error ? error.message : String(error),
      };
    }
    const durationMs = Math.max(0, now().getTime() - probeStartedAt);
    executedProbes += 1;
    let costUsd = 0;
    if ("costUsd" in execution && execution.costUsd !== undefined) {
      try {
        costUsd = finiteNonNegative(
          execution.costUsd,
          `${probe.id}.costUsd`,
        );
      } catch (error) {
        execution = {
          outcome: "failed",
          category: "harness",
          summary: error instanceof Error ? error.message : String(error),
        };
      }
    }
    observedCostUsd += costUsd;
    if (observedCostUsd > maxCostUsd) exhausted = true;
    results.push(
      resultFromExecution(
        probe,
        declaration.status,
        declaration.source,
        execution,
        durationMs,
      ),
    );
  }

  const blockingProbeIds = results
    .filter((result) => result.gateImpact === "block")
    .map((result) => result.id);
  const inconclusiveProbeIds = results
    .filter((result) => result.gateImpact === "inconclusive")
    .map((result) => result.id);
  const contractPassed =
    blockingProbeIds.length === 0 && inconclusiveProbeIds.length === 0;

  return {
    schema: RUNTIME_CONFORMANCE_SCHEMA,
    reportId: options.reportId ?? randomUUID(),
    provenance: driver.provenance,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    budget: {
      maxProbes,
      maxCostUsd,
      executedProbes,
      observedCostUsd,
      exhausted,
    },
    results,
    gate: {
      contractPassed,
      eligibleForProduction:
        driver.provenance.mode !== "offline-contract" && contractPassed,
      blockingProbeIds,
      inconclusiveProbeIds,
    },
    counts: countVerdicts(results),
  };
}

function resultFromExecution<K extends ConformanceProbeId>(
  probe: ConformanceProbeDefinition<K>,
  declaration: CapabilityDeclaration,
  declarationSource: string,
  execution: ConformanceProbeExecution<K>,
  durationMs: number,
): ConformanceProbeResult {
  const costUsd =
    "costUsd" in execution && execution.costUsd !== undefined
      ? execution.costUsd
      : 0;

  if (execution.outcome === "observed") {
    const validation = probe.validate(execution.evidence);
    const verdict = reconcileObserved(declaration, validation);
    return buildResult({
      probe,
      declaration,
      declarationSource,
      verdict,
      summary: validation.summary,
      evidence: validation.evidence,
      durationMs,
      costUsd,
    });
  }

  if (execution.outcome === "skipped") {
    return buildResult({
      probe,
      declaration,
      declarationSource,
      verdict: "SKIPPED",
      summary: execution.summary,
      evidence: {},
      durationMs,
      category: execution.category,
      costUsd,
    });
  }

  if (execution.outcome === "unknown") {
    return buildResult({
      probe,
      declaration,
      declarationSource,
      verdict: "UNKNOWN",
      summary: execution.summary,
      evidence: {},
      durationMs,
      category: execution.category,
      costUsd,
    });
  }

  if (execution.outcome === "unsupported") {
    return buildResult({
      probe,
      declaration,
      declarationSource,
      verdict:
        declaration === "supported" || declaration === "partial"
          ? "DRIFT"
          : "UNSUPPORTED",
      summary: execution.summary,
      evidence: {},
      durationMs,
      category: "unsupported",
      costUsd,
    });
  }

  return buildResult({
    probe,
    declaration,
    declarationSource,
    verdict:
      declaration === "supported" || declaration === "partial"
        ? "DRIFT"
        : "UNKNOWN",
    summary: execution.summary,
    evidence: {},
    durationMs,
    category: execution.category,
    costUsd,
  });
}

function reconcileObserved(
  declaration: CapabilityDeclaration,
  validation: ProbeValidation,
): ConformanceVerdict {
  if (validation.status === "passed") {
    return declaration === "unsupported" || declaration === "partial"
      ? "DRIFT"
      : "SUPPORTED";
  }
  if (validation.status === "partial") {
    return declaration === "partial" || declaration === "unknown"
      ? "PARTIAL"
      : "DRIFT";
  }
  return declaration === "supported" || declaration === "partial"
    ? "DRIFT"
    : "UNKNOWN";
}

function buildResult<K extends ConformanceProbeId>({
  probe,
  declaration,
  declarationSource,
  verdict,
  summary,
  evidence,
  durationMs,
  category,
  costUsd,
}: {
  probe: ConformanceProbeDefinition<K>;
  declaration: CapabilityDeclaration;
  declarationSource: string;
  verdict: ConformanceVerdict;
  summary: string;
  evidence: Record<string, string | number | boolean>;
  durationMs: number;
  category?: ConformanceFailureCategory;
  costUsd: number;
}): ConformanceProbeResult {
  return {
    id: probe.id,
    title: probe.title,
    requirement: probe.requirement,
    declaration,
    declarationSource: sanitizeText(declarationSource),
    verdict,
    gateImpact: gateImpact(probe.requirement, declaration, verdict),
    summary: sanitizeText(summary),
    evidence: sanitizeEvidence(evidence),
    durationMs,
    ...(category ? { category } : {}),
    costUsd,
  };
}

function gateImpact(
  requirement: ConformanceProbeResult["requirement"],
  declaration: CapabilityDeclaration,
  verdict: ConformanceVerdict,
): ConformanceProbeResult["gateImpact"] {
  if (verdict === "DRIFT") return "block";
  if (verdict === "SKIPPED" || verdict === "UNKNOWN") return "inconclusive";

  if (requirement === "required") {
    return verdict === "SUPPORTED" ? "pass" : "block";
  }

  if (declaration === "unknown") return "inconclusive";
  if (declaration === "supported") {
    return verdict === "SUPPORTED" ? "pass" : "block";
  }
  if (declaration === "partial") {
    return verdict === "PARTIAL" ? "pass" : "block";
  }
  return verdict === "UNSUPPORTED" ? "pass" : "block";
}

function countVerdicts(
  results: readonly ConformanceProbeResult[],
): Record<ConformanceVerdict, number> {
  const counts: Record<ConformanceVerdict, number> = {
    SUPPORTED: 0,
    UNSUPPORTED: 0,
    PARTIAL: 0,
    UNKNOWN: 0,
    SKIPPED: 0,
    DRIFT: 0,
  };
  for (const result of results) counts[result.verdict] += 1;
  return counts;
}

function sanitizeEvidence(
  evidence: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(evidence).map(([key, value]) => [
      key.slice(0, 80),
      typeof value === "string" ? sanitizeText(value) : value,
    ]),
  );
}

export function sanitizeText(value: string): string {
  return value
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|secret|token|password)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/([?&](?:key|secret|token)=)[^&\s]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number.`);
  }
  return value;
}
