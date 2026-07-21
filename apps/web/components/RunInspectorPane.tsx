"use client";

import { SlideOverPane } from "@/components/SlideOverPane";
import {
  type LiveReasoningBlock,
  type RunInspectorEvent,
  type RunInspectorTrace,
  isRecord,
  parseRunInspectorTrace,
} from "@/lib/run-inspector";
import { useEffect, useMemo, useState } from "react";

interface Props {
  runId: string;
  onClose: () => void;
  liveReasoning?: LiveReasoningBlock[];
}

type InspectorTab =
  | "overview"
  | "timeline"
  | "context"
  | "reasoning"
  | "tools"
  | "output"
  | "raw";

type TimelineFilter = "all" | "provider" | "tools" | "errors";

const TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "timeline", label: "Timeline" },
  { id: "context", label: "Context" },
  { id: "reasoning", label: "Reasoning" },
  { id: "tools", label: "Tools" },
  { id: "output", label: "Output" },
  { id: "raw", label: "Raw" },
];

const MIN_INSPECTOR_WIDTH = 420;
const MAX_INSPECTOR_WIDTH = 1_000;
const POLL_INTERVAL_MS = 1_500;

export function RunInspectorPane({
  runId,
  onClose,
  liveReasoning = [],
}: Props) {
  const [trace, setTrace] = useState<RunInspectorTrace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<InspectorTab>("overview");
  const [timelineFilter, setTimelineFilter] =
    useState<TimelineFilter>("all");

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    async function load() {
      try {
        const response = await fetch(
          `/api/admin/runs/${encodeURIComponent(runId)}/trace`,
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { trace?: unknown };
        const parsed = parseRunInspectorTrace(body.trace);
        if (!parsed) throw new Error("Invalid inspector response");
        if (!active) return;
        setTrace(parsed);
        setError(undefined);
        setLoading(false);
        if (isActiveStatus(parsed.run.status)) {
          timer = setTimeout(load, POLL_INTERVAL_MS);
        }
      } catch (nextError) {
        if (!active || controller.signal.aborted) return;
        setError(
          nextError instanceof Error ? nextError.message : String(nextError),
        );
        setLoading(false);
      }
    }

    setTrace(null);
    setLoading(true);
    setError(undefined);
    void load();
    return () => {
      active = false;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  const filteredEvents = useMemo(
    () => filterTimeline(trace?.events ?? [], timelineFilter),
    [timelineFilter, trace?.events],
  );

  return (
    <SlideOverPane
      ariaLabel="Run Inspector"
      defaultWidth={680}
      minWidth={MIN_INSPECTOR_WIDTH}
      maxWidth={MAX_INSPECTOR_WIDTH}
      onClose={onClose}
      paneTestId="run-inspector"
      resizerLabel="Resize Run Inspector"
      resizerTestId="run-inspector-resizer"
      storageKey="comparative.slide-over.run-inspector.width"
    >
      <header className="flex min-h-12 shrink-0 touch-none items-center gap-2 border-b border-hairline px-3 md:touch-auto">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-hairline bg-surface text-muted">
          <TraceIcon />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-medium text-ink">
              Run Inspector
            </h2>
            {trace ? <StatusPill status={trace.run.status} /> : null}
          </div>
          <p className="truncate font-mono text-2xs text-muted">{runId}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close Run Inspector"
          title="Close"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink"
        >
          <CloseIcon />
        </button>
      </header>

      <div className="shrink-0 overflow-x-auto border-b border-hairline">
        <div role="tablist" className="flex min-w-max px-2">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={`h-10 border-b px-2.5 text-2xs font-medium ${
                tab === item.id
                  ? "border-ink text-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && !trace ? (
          <PaneState label="Loading run trace..." />
        ) : error && !trace ? (
          <PaneState label={`Trace unavailable: ${error}`} tone="error" />
        ) : trace ? (
          <div className="px-4 py-4">
            {tab === "overview" ? <OverviewTab trace={trace} /> : null}
            {tab === "timeline" ? (
              <TimelineTab
                events={filteredEvents}
                filter={timelineFilter}
                onFilterChange={setTimelineFilter}
              />
            ) : null}
            {tab === "context" ? <ContextTab trace={trace} /> : null}
            {tab === "reasoning" ? (
              <ReasoningTab trace={trace} liveReasoning={liveReasoning} />
            ) : null}
            {tab === "tools" ? <ToolsTab trace={trace} /> : null}
            {tab === "output" ? <OutputTab trace={trace} /> : null}
            {tab === "raw" ? <RawTab trace={trace} /> : null}
          </div>
        ) : null}
      </div>
    </SlideOverPane>
  );
}

function OverviewTab({ trace }: { trace: RunInspectorTrace }) {
  const inputs = trace.run.inputs ?? {};
  const outputs = trace.run.outputs ?? {};
  const metrics = recordValue(outputs.metrics);
  const usage = recordValue(outputs.usage);
  const providerRun = recordValue(outputs.providerRun);
  const modelSelection = recordValue(outputs.modelSelection);
  const captureMetadata = recordValue(
    trace.events.find(
      (event) => event.eventType === "provider_context_snapshot",
    )?.metadata,
  );
  return (
    <div className="space-y-5">
      <SectionTitle title="Execution" />
      <dl className="grid grid-cols-2 border-l border-t border-hairline text-xs">
        <Metric label="Status" value={trace.run.status} />
        <Metric label="User" value={trace.run.actorName ?? trace.run.actorEmail} />
        <Metric
          label="Requested model"
          value={stringValue(outputs.requestedModelId) ?? trace.run.modelId}
        />
        <Metric
          label="Resolved model"
          value={stringValue(outputs.modelId) ?? trace.run.modelId}
        />
        <Metric
          label="Provider model"
          value={stringValue(outputs.providerModelId)}
        />
        <Metric
          label="Runtime target"
          value={stringValue(outputs.runtimeTarget) ?? stringValue(inputs.runtimeTarget)}
        />
        <Metric
          label="Route reason"
          value={stringValue(modelSelection?.reason)}
        />
        <Metric
          label="Provider run"
          value={stringValue(providerRun?.providerRunId)}
        />
        <Metric
          label="Trace capture"
          value={stringValue(captureMetadata?.captureMode) ?? "standard"}
        />
        <Metric
          label="Trace schema"
          value={stringValue(captureMetadata?.schema)}
        />
      </dl>

      <SectionTitle title="Timing and usage" />
      <dl className="grid grid-cols-2 border-l border-t border-hairline text-xs">
        <Metric
          label="First token"
          value={formatMs(numberValue(metrics?.requestToFirstTokenMs))}
        />
        <Metric
          label="Provider latency"
          value={formatMs(providerLatency(trace.events))}
        />
        <Metric
          label="Completed"
          value={formatMs(numberValue(metrics?.requestToCompletedMs))}
        />
        <Metric
          label="Tokens"
          value={formatTokens(
            numberValue(usage?.tokensIn) ?? numberValue(outputs.tokensIn),
            numberValue(usage?.tokensOut) ?? numberValue(outputs.tokensOut),
          )}
        />
        <Metric
          label="Cache read"
          value={formatInteger(numberValue(usage?.cacheReadInputTokens))}
        />
        <Metric label="Attempts" value={String(trace.run.attemptCount ?? 1)} />
      </dl>

      {trace.run.error ? (
        <div className="border-l-2 border-danger px-3 py-2 text-xs text-danger">
          {trace.run.error}
        </div>
      ) : null}
    </div>
  );
}

function TimelineTab({
  events,
  filter,
  onFilterChange,
}: {
  events: RunInspectorEvent[];
  filter: TimelineFilter;
  onFilterChange: (filter: TimelineFilter) => void;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <SectionTitle title="Observed execution" />
        <select
          aria-label="Filter timeline"
          value={filter}
          onChange={(event) =>
            onFilterChange(event.target.value as TimelineFilter)
          }
          className="h-8 rounded-md border border-hairline bg-canvas px-2 text-2xs text-ink"
        >
          <option value="all">All events</option>
          <option value="provider">Provider</option>
          <option value="tools">Tools</option>
          <option value="errors">Errors</option>
        </select>
      </div>
      <EventList events={events} emptyLabel="No events match this filter." />
    </div>
  );
}

function ContextTab({ trace }: { trace: RunInspectorTrace }) {
  const contextEvent = [...trace.events]
    .reverse()
    .find((event) => event.eventType === "provider_context_snapshot");
  const output = recordValue(contextEvent?.output);
  const requests = Array.isArray(output?.requests) ? output.requests : [];
  const receipt = trace.run.inputs?.contextReceipt;
  const route = trace.run.inputs?.routeReceipt ?? trace.run.inputs?.runtimeRoute;

  return (
    <div className="space-y-5">
      <SectionTitle title="Effective provider context" />
      {requests.length === 0 ? (
        <EmptyText label="No provider request snapshot was captured for this run." />
      ) : (
        <div className="divide-y divide-hairline border-y border-hairline">
          {requests.map((request, index) => {
            const requestRecord = recordValue(request);
            const safeRequest = recordValue(requestRecord?.request);
            return (
              <details key={index} className="group py-2">
                <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-ink marker:hidden">
                  <Chevron />
                  <span>Provider request {index + 1}</span>
                  <span className="ml-auto font-mono text-2xs text-muted">
                    {shortHash(stringValue(requestRecord?.requestHash))}
                  </span>
                </summary>
                <div className="mt-3 space-y-4 pl-5">
                  {safeRequest?.truncated === true ? (
                    <div className="border-l-2 border-warning px-3 py-2 text-2xs text-muted">
                      Context content was truncated by the standard trace size
                      policy. Hashes still identify the exact provider request.
                    </div>
                  ) : null}
                  <ContextValue
                    label="System prompt"
                    value={safeRequest?.systemPrompt}
                  />
                  <ContextValue
                    label="Volatile suffix"
                    value={safeRequest?.volatileSystemSuffix}
                  />
                  <JsonSection label="Messages" value={safeRequest?.messages} />
                  <JsonSection label="Mounted tool schemas" value={safeRequest?.tools} />
                </div>
              </details>
            );
          })}
        </div>
      )}
      <JsonSection label="Context receipt" value={receipt} />
      <JsonSection label="Route receipt" value={route} />
    </div>
  );
}

function ReasoningTab({
  trace,
  liveReasoning,
}: {
  trace: RunInspectorTrace;
  liveReasoning: LiveReasoningBlock[];
}) {
  const event = [...trace.events]
    .reverse()
    .find((item) => item.eventType === "provider_reasoning");
  const persisted = recordValue(event?.output);
  const persistedBlocks = Array.isArray(persisted?.blocks)
    ? persisted.blocks
    : [];
  const blocks = mergeReasoningBlocks(persistedBlocks, liveReasoning);
  const state =
    liveReasoning.some((block) => block.text.length > 0) ||
    blocks.some((block) => stringValue(block.text))
      ? "available"
      : stringValue(persisted?.state) ?? "absent";

  return (
    <div className="space-y-4">
      <div>
        <SectionTitle title="Provider reasoning" />
        <p className="mt-1 text-2xs leading-relaxed text-muted">
          Provider-returned diagnostic content may be summarized and is not a
          complete or guaranteed-faithful record of private model reasoning.
        </p>
      </div>
      {blocks.length === 0 ? (
        <EmptyText
          label={
            state === "redacted"
              ? "The provider returned encrypted reasoning for this run."
              : "This model did not return inspectable reasoning for this run. Tool, context, output, and timing traces are still available."
          }
        />
      ) : (
        <div className="divide-y divide-hairline border-y border-hairline">
          {blocks.map((block, index) => (
            <div key={reasoningBlockKey(block, index)} className="py-3">
              <div className="mb-2 flex items-center gap-2 text-2xs text-muted">
                <span>
                  Iteration {(numberValue(block.iteration) ?? 0) + 1}
                </span>
                <span>Block {numberValue(block.blockIndex) ?? index}</span>
                {block.redacted === true ? <span>Encrypted portion</span> : null}
                {isActiveStatus(trace.run.status) &&
                liveReasoning.length > 0 ? (
                  <span className="ml-auto text-success">Live</span>
                ) : null}
              </div>
              <div className="whitespace-pre-wrap text-xs leading-relaxed text-ink [overflow-wrap:anywhere]">
                {stringValue(block.text) ?? "Encrypted reasoning content"}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolsTab({ trace }: { trace: RunInspectorTrace }) {
  const events = trace.events.filter(
    (event) => event.eventType === "tool_call" || event.eventType === "tool_result",
  );
  return (
    <div>
      <SectionTitle title="Tool execution" />
      <div className="mt-3">
        <EventList events={events} emptyLabel="No tools ran during this turn." />
      </div>
    </div>
  );
}

function OutputTab({ trace }: { trace: RunInspectorTrace }) {
  const output = trace.run.outputs ?? {};
  const assistantText = stringValue(output.assistantText);
  return (
    <div className="space-y-5">
      <SectionTitle title="Provider-visible output" />
      {assistantText ? (
        <pre className="whitespace-pre-wrap border-y border-hairline py-3 font-sans text-xs leading-relaxed text-ink [overflow-wrap:anywhere]">
          {assistantText}
        </pre>
      ) : (
        <EmptyText label="No assistant output was stored for this run." />
      )}
      <JsonSection label="Artifacts" value={output.artifacts} />
      <JsonSection label="App versions" value={output.appDraftVersions} />
      <JsonSection label="Post-processing" value={output.recommendations} />
    </div>
  );
}

function RawTab({ trace }: { trace: RunInspectorTrace }) {
  return (
    <div className="space-y-3">
      <div>
        <SectionTitle title="Normalized events" />
        <p className="mt-1 text-2xs text-muted">
          Schema-versioned, redacted events observed by Comparative. Raw
          provider delta retention is not enabled for this run.
        </p>
      </div>
      <pre className="max-h-none overflow-auto border-y border-hairline py-3 font-mono text-2xs leading-relaxed text-ink [overflow-wrap:anywhere]">
        {JSON.stringify(
          {
            schema: trace.schema,
            runId: trace.run.id,
            events: trace.events,
            auditEvents: trace.auditEvents,
          },
          null,
          2,
        )}
      </pre>
    </div>
  );
}

function EventList({
  events,
  emptyLabel,
}: {
  events: RunInspectorEvent[];
  emptyLabel: string;
}) {
  if (events.length === 0) return <EmptyText label={emptyLabel} />;
  return (
    <div className="divide-y divide-hairline border-y border-hairline">
      {events.map((event) => (
        <details key={event.id} className="group py-2">
          <summary className="flex cursor-pointer list-none items-center gap-2 marker:hidden">
            <StatusDot status={event.status} />
            <span className="min-w-0 flex-1 truncate text-xs text-ink">
              {event.label}
            </span>
            <span className="shrink-0 text-2xs text-muted">
              {formatRelativeTime(event.occurredAt, events[0]?.occurredAt)}
            </span>
            <Chevron />
          </summary>
          <div className="mt-2 space-y-2 pl-4">
            <div className="font-mono text-2xs text-muted">
              {[event.eventType, event.provider, event.toolName]
                .filter(Boolean)
                .join(" / ")}
            </div>
            {event.error ? (
              <div className="text-2xs text-danger">{event.error}</div>
            ) : null}
            {event.input !== null && event.input !== undefined ? (
              <JsonSection label="Input" value={event.input} compact />
            ) : null}
            {event.output !== null && event.output !== undefined ? (
              <JsonSection label="Output" value={event.output} compact />
            ) : null}
            {event.metadata !== null && event.metadata !== undefined ? (
              <JsonSection label="Metadata" value={event.metadata} compact />
            ) : null}
          </div>
        </details>
      ))}
    </div>
  );
}

function JsonSection({
  label,
  value,
  compact = false,
}: {
  label: string;
  value: unknown;
  compact?: boolean;
}) {
  if (value === undefined || value === null) return null;
  return (
    <details className={compact ? "" : "border-y border-hairline py-2"}>
      <summary className="cursor-pointer list-none text-2xs font-medium text-muted marker:hidden">
        {label}
      </summary>
      <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap font-mono text-2xs leading-relaxed text-ink [overflow-wrap:anywhere]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

function ContextValue({ label, value }: { label: string; value: unknown }) {
  const text = stringValue(value);
  if (!text) return null;
  return (
    <div>
      <div className="mb-1 text-2xs font-medium text-muted">{label}</div>
      <div className="max-h-64 overflow-auto whitespace-pre-wrap text-2xs leading-relaxed text-ink [overflow-wrap:anywhere]">
        {text}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0 border-b border-r border-hairline px-3 py-2.5">
      <dt className="text-2xs text-muted">{label}</dt>
      <dd className="mt-1 truncate text-xs font-medium text-ink">
        {typeof value === "string" && value.length > 0 ? value : "n/a"}
      </dd>
    </div>
  );
}

function SectionTitle({ title }: { title: string }) {
  return <h3 className="text-xs font-semibold text-ink">{title}</h3>;
}

function PaneState({
  label,
  tone = "muted",
}: {
  label: string;
  tone?: "muted" | "error";
}) {
  return (
    <div
      className={`flex h-full items-center justify-center px-6 text-center text-xs ${
        tone === "error" ? "text-danger" : "text-muted"
      }`}
    >
      {label}
    </div>
  );
}

function EmptyText({ label }: { label: string }) {
  return (
    <div className="border-y border-hairline py-6 text-center text-2xs leading-relaxed text-muted">
      {label}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const active = isActiveStatus(status);
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-2xs uppercase ${
        active
          ? "bg-info-bg text-info"
          : status === "failed"
            ? "bg-danger-bg text-danger"
            : "bg-success-bg text-success"
      }`}
    >
      {status}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  const classes =
    status === "failed"
      ? "bg-danger"
      : status === "pending" || status === "running"
        ? "animate-pulse bg-info"
        : status === "info"
          ? "bg-muted"
          : "bg-success";
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${classes}`} />;
}

function TraceIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 4.5h4M9 4.5h4M3 8h7M12 8h1M3 11.5h2M7 11.5h6" />
      <circle cx="8" cy="4.5" r="1" />
      <circle cx="11" cy="8" r="1" />
      <circle cx="6" cy="11.5" r="1" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M3 3l10 10M13 3L3 13" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-muted transition-transform group-open:rotate-90"
      aria-hidden="true"
    >
      <path d="m6 3 5 5-5 5" />
    </svg>
  );
}

function filterTimeline(
  events: RunInspectorEvent[],
  filter: TimelineFilter,
): RunInspectorEvent[] {
  if (filter === "all") return events;
  if (filter === "tools") {
    return events.filter(
      (event) =>
        event.eventType === "tool_call" || event.eventType === "tool_result",
    );
  }
  if (filter === "errors") {
    return events.filter(
      (event) => event.status === "failed" || Boolean(event.error),
    );
  }
  return events.filter(
    (event) =>
      event.provider === "bedrock" || event.eventType.startsWith("provider_"),
  );
}

function mergeReasoningBlocks(
  persisted: unknown[],
  live: LiveReasoningBlock[],
): Array<Record<string, unknown>> {
  const blocks = new Map<string, Record<string, unknown>>();
  for (const value of persisted) {
    const block = recordValue(value);
    if (!block) continue;
    blocks.set(reasoningBlockKey(block, blocks.size), block);
  }
  for (const value of live) {
    blocks.set(reasoningBlockKey(value, blocks.size), { ...value });
  }
  return [...blocks.values()].sort(
    (left, right) =>
      (numberValue(left.iteration) ?? 0) -
        (numberValue(right.iteration) ?? 0) ||
      (numberValue(left.blockIndex) ?? 0) -
        (numberValue(right.blockIndex) ?? 0),
  );
}

function reasoningBlockKey(value: unknown, fallback: number): string {
  const block = recordValue(value);
  return block
    ? `${numberValue(block.iteration) ?? 0}:${numberValue(block.blockIndex) ?? fallback}`
    : `unknown:${fallback}`;
}

function providerLatency(events: RunInspectorEvent[]): number | undefined {
  const event = [...events]
    .reverse()
    .find((item) => item.eventType === "provider_response_metadata");
  const output = recordValue(event?.output);
  const responses = Array.isArray(output?.responses) ? output.responses : [];
  return responses.reduce<number | undefined>((max, response) => {
    const latency = numberValue(recordValue(response)?.latencyMs);
    if (latency === undefined) return max;
    return Math.max(max ?? 0, latency);
  }, undefined);
}

function isActiveStatus(status: string): boolean {
  return status === "queued" || status === "running";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatMs(value: number | undefined): string {
  if (value === undefined) return "n/a";
  if (value < 1_000) return `${Math.round(value)}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

function formatInteger(value: number | undefined): string {
  return value === undefined ? "n/a" : Math.round(value).toLocaleString();
}

function formatTokens(input: number | undefined, output: number | undefined) {
  return input === undefined && output === undefined
    ? "n/a"
    : `${formatInteger(input ?? 0)} in / ${formatInteger(output ?? 0)} out`;
}

function shortHash(value: string | undefined): string {
  return value ? value.slice(0, 10) : "unhashed";
}

function formatRelativeTime(value: string, start?: string): string {
  const timestamp = Date.parse(value);
  const origin = start ? Date.parse(start) : Number.NaN;
  if (Number.isFinite(timestamp) && Number.isFinite(origin)) {
    const delta = Math.max(0, timestamp - origin);
    return delta < 1_000 ? `+${delta}ms` : `+${(delta / 1_000).toFixed(1)}s`;
  }
  return value;
}
