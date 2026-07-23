import { formatDateTime as formatDisplayDateTime } from "@/lib/format-date";

export type RuntimeReportLane =
  | "fast-local"
  | "tool-local"
  | "durable-local"
  | "cursor-cloud"
  | "unknown";

export interface RuntimeReportRow {
  id: string;
  status: string;
  runtime: string | null;
  modelId: string | null;
  inputs: unknown;
  outputs: unknown;
  error: string | null;
}

export interface LaneLatencySummary {
  lane: RuntimeReportLane;
  runCount: number;
  firstTokenSamples: number;
  failedCount: number;
  p50FirstTokenMs: number | null;
  p95FirstTokenMs: number | null;
}

export interface FailureGroupSummary {
  lane: RuntimeReportLane;
  runtimeTarget: string;
  provider: string;
  modelId: string;
  errorClass: string;
  count: number;
}

export interface RuntimeV2Report {
  rowsAnalyzed: number;
  fastLocalSampleCount: number;
  laneLatency: LaneLatencySummary[];
  failureGroups: FailureGroupSummary[];
}

export function formatSkill(value: string | null): string {
  if (value === "developer-briefing") return "Developer Briefing";
  return value
    ? value
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ")
    : "Workflow run";
}

export function shortId(value: string): string {
  return value.slice(0, 8);
}

export function formatDateTime(value: Date): string {
  return formatDisplayDateTime(value);
}

export function formatDuration(
  startedAt: Date,
  completedAt: Date,
): string {
  const ms = Math.max(0, completedAt.getTime() - startedAt.getTime());
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function formatNullableMs(
  value: number | null | undefined,
): string {
  if (typeof value !== "number") return "n/a";
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

const REPORT_LANES: RuntimeReportLane[] = [
  "fast-local",
  "tool-local",
  "durable-local",
  "cursor-cloud",
  "unknown",
];

export function buildRuntimeV2Report(
  rows: readonly RuntimeReportRow[],
): RuntimeV2Report {
  const records = rows.map(toRuntimeReportRecord);
  const laneLatency = REPORT_LANES.map((lane) => {
    const laneRecords = records.filter((record) => record.lane === lane);
    const firstTokenValues = laneRecords
      .map((record) => record.requestToFirstTokenMs)
      .filter(isFiniteNumber)
      .sort((a, b) => a - b);
    return {
      lane,
      runCount: laneRecords.length,
      firstTokenSamples: firstTokenValues.length,
      failedCount: laneRecords.filter((record) => record.status === "failed")
        .length,
      p50FirstTokenMs: percentile(firstTokenValues, 0.5),
      p95FirstTokenMs: percentile(firstTokenValues, 0.95),
    } satisfies LaneLatencySummary;
  }).filter(
    (summary) => summary.runCount > 0 || summary.lane !== "unknown",
  );

  return {
    rowsAnalyzed: rows.length,
    fastLocalSampleCount:
      laneLatency.find((summary) => summary.lane === "fast-local")
        ?.firstTokenSamples ?? 0,
    laneLatency,
    failureGroups: groupFailures(records),
  };
}

interface RuntimeReportRecord {
  lane: RuntimeReportLane;
  status: string;
  runtimeTarget: string;
  provider: string;
  modelId: string;
  errorClass: string;
  requestToFirstTokenMs: number | null;
}

function toRuntimeReportRecord(row: RuntimeReportRow): RuntimeReportRecord {
  const inputs = isRecord(row.inputs) ? row.inputs : {};
  const outputs = isRecord(row.outputs) ? row.outputs : {};
  const route = isRecord(inputs.runtimeRoute)
    ? inputs.runtimeRoute
    : isRecord(inputs.routeReceipt)
      ? inputs.routeReceipt
      : {};
  const metrics = isRecord(outputs.metrics) ? outputs.metrics : {};
  const providerRun = isRecord(outputs.providerRun) ? outputs.providerRun : {};
  const modelSelection = isRecord(outputs.modelSelection)
    ? outputs.modelSelection
    : {};
  const errorDetails = Array.isArray(outputs.errorDetails)
    ? outputs.errorDetails.filter(isRecord)
    : [];

  return {
    lane: parseLane({ route, inputs, providerRun }),
    status: row.status,
    runtimeTarget: stringValue(route.runtimeTarget) ?? stringValue(outputs.runtimeTarget) ?? "unknown",
    provider:
      stringValue(providerRun.providerAgentId) ??
      stringValue(outputs.runtime) ??
      row.runtime ??
      "unknown",
    modelId:
      stringValue(outputs.modelId) ??
      stringValue(modelSelection.modelId) ??
      row.modelId ??
      "unknown",
    errorClass: classifyError({
      rowError: row.error,
      errorDetails,
    }),
    requestToFirstTokenMs: numberValue(metrics.requestToFirstTokenMs),
  };
}

function parseLane({
  route,
  inputs,
  providerRun,
}: {
  route: Record<string, unknown>;
  inputs: Record<string, unknown>;
  providerRun: Record<string, unknown>;
}): RuntimeReportLane {
  const executionMode =
    stringValue(inputs.executionMode) ?? stringValue(providerRun.executionMode);
  if (executionMode === "cloud") return "cursor-cloud";
  const lane = stringValue(route.lane);
  if (
    lane === "fast-local" ||
    lane === "tool-local" ||
    lane === "durable-local" ||
    lane === "cursor-cloud"
  ) {
    return lane;
  }
  return "unknown";
}

function classifyError({
  rowError,
  errorDetails,
}: {
  rowError: string | null;
  errorDetails: Record<string, unknown>[];
}): string {
  const first = errorDetails[0];
  const explicit =
    stringValue(first?.category) ??
    stringValue(first?.code) ??
    stringValue(first?.name);
  if (explicit) return explicit;
  const error = rowError?.toLowerCase() ?? "";
  if (!error) return "none";
  if (/\b(throttl|rate limit|too many requests)\b/.test(error)) {
    return "rate_limit";
  }
  if (
    /\b(?:bedrock-agentcore|agentcore\s*runtime|agentcoreruntime)\b/.test(error) &&
    /\b(?:accessdenied(?:exception)?|access denied|not authorized)\b/.test(error)
  ) {
    return "runtime_authorization_denied";
  }
  if (/\b(access denied|not authorized|marketplace|subscription)\b/.test(error)) {
    return "model_access";
  }
  if (/\b(timeout|timed out|deadline)\b/.test(error)) return "timeout";
  if (/\btool|mcp\b/.test(error)) return "tool_error";
  return "runtime_error";
}

function groupFailures(
  records: readonly RuntimeReportRecord[],
): FailureGroupSummary[] {
  const groups = new Map<string, FailureGroupSummary>();
  for (const record of records) {
    if (record.status !== "failed") continue;
    const key = [
      record.lane,
      record.runtimeTarget,
      record.provider,
      record.modelId,
      record.errorClass,
    ].join("|");
    const current =
      groups.get(key) ??
      ({
        lane: record.lane,
        runtimeTarget: record.runtimeTarget,
        provider: record.provider,
        modelId: record.modelId,
        errorClass: record.errorClass,
        count: 0,
      } satisfies FailureGroupSummary);
    current.count += 1;
    groups.set(key, current);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function percentile(sortedValues: readonly number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * p) - 1),
  );
  return sortedValues[index] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isFiniteNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
