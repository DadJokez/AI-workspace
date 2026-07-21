import { auditLog, getDb, runs, runEvents, users } from "@ai-workspace/db";
import {
  parseAssistantSources,
  type AssistantSource,
} from "@ai-workspace/agent";
import { asc, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { MessageBubble } from "@/components/MessageBubble";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { runEventsToActivityEvents } from "@/lib/run-events";
import type { PersistedRecommendation } from "@/lib/recommendations";
import type {
  PersistedToolCall,
  PersistedToolResult,
} from "@/lib/tool-events";
import { canRetryWorkflowRun } from "@/lib/workflow-retry";
import { ChatRunActionButtons } from "../ChatRunActionButtons";
import { RetryRunButton } from "../RetryRunButton";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

interface RunOutput {
  briefingMarkdown?: string;
  assistantText?: string;
  toolCalls?: PersistedToolCall[];
  toolResults?: PersistedToolResult[];
  tokensIn?: number;
  tokensOut?: number;
  modelId?: string;
  requestedModelId?: string;
  providerModelId?: string;
  modelSelection?: {
    reason?: string;
  };
  runtime?: string;
  runtimeTarget?: string;
  recommendations?: PersistedRecommendation[];
  sources?: AssistantSource[];
  errorDetails?: Array<{
    code?: string;
    category?: string;
    rawMessage?: string;
  }>;
  metrics?: RunTimingMetrics;
  providerRun?: {
    providerAgentId?: string;
    providerRunId?: string;
    executionMode?: string;
  };
}

interface RunTimingMetrics {
  requestStartedAt?: string;
  inlineStartedAt?: string;
  contextReadyAt?: string;
  providerStartedAt?: string;
  firstTokenAt?: string;
  completedAt?: string;
  requestToInlineMs?: number;
  inlineToContextReadyMs?: number;
  requestToProviderMs?: number;
  providerToFirstTokenMs?: number;
  requestToFirstTokenMs?: number;
  requestToCompletedMs?: number;
}

export default async function AdminRunDetailPage({ params }: Props) {
  const sessionUser = await getSessionUser();
  if (!sessionUser || sessionUser.role !== "admin") {
    redirect("/chat");
  }

  const { id } = await params;
  const db = getDb();
  const rows = await db
    .select({
      id: runs.id,
      skillSlug: runs.skillSlug,
      status: runs.status,
      triggerType: runs.triggerType,
      eventTriggerId: runs.eventTriggerId,
      eventDeliveryId: runs.eventDeliveryId,
      runtime: runs.runtime,
      modelId: runs.modelId,
      inputs: runs.inputs,
      outputs: runs.outputs,
      error: runs.error,
      startedAt: runs.startedAt,
      completedAt: runs.completedAt,
      createdAt: runs.createdAt,
      updatedAt: runs.updatedAt,
      actorEmail: users.email,
      actorName: users.displayName,
    })
    .from(runs)
    .leftJoin(users, eq(runs.userId, users.id))
    .where(eq(runs.id, id))
    .limit(1);

  const run = rows[0];
  if (!run) notFound();

  const auditRows = await db
    .select({
      id: auditLog.id,
      actionType: auditLog.actionType,
      status: auditLog.status,
      provider: auditLog.provider,
      toolName: auditLog.toolName,
      toolCallId: auditLog.toolCallId,
      error: auditLog.error,
      startedAt: auditLog.startedAt,
      completedAt: auditLog.completedAt,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(eq(auditLog.runId, run.id))
    .orderBy(desc(auditLog.createdAt))
    .limit(100);

  const runEventRows = await db
    .select({
      id: runEvents.id,
      sequence: runEvents.sequence,
      eventType: runEvents.eventType,
      status: runEvents.status,
      label: runEvents.label,
      provider: runEvents.provider,
      toolName: runEvents.toolName,
      toolCallId: runEvents.toolCallId,
      error: runEvents.error,
      occurredAt: runEvents.occurredAt,
    })
    .from(runEvents)
    .where(eq(runEvents.runId, run.id))
    .orderBy(asc(runEvents.sequence), asc(runEvents.occurredAt))
    .limit(250);

  const output = parseRunOutput(run.outputs);
  const prompt = parsePrompt(run.inputs);
  const contextDebug = parseRunContextDebug(run.inputs);
  const retryInfo = parseRetryInfo(run.inputs);
  const toolCalls = output.toolCalls ?? [];
  const toolResults = output.toolResults ?? [];
  const activityEvents = runEventsToActivityEvents(runEventRows);
  const primaryOutput = output.briefingMarkdown ?? output.assistantText;
  const primaryOutputLabel =
    run.skillSlug === "chat-turn" ? "Answer" : "Briefing";
  const tokenText =
    typeof output.tokensIn === "number" || typeof output.tokensOut === "number"
      ? `${output.tokensIn ?? 0} in / ${output.tokensOut ?? 0} out`
      : "n/a";

  return (
    <section className="py-2">
      <div className="px-6 pb-3 pt-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Link href="/admin/runs" className="hover:text-ink">
            Runs
          </Link>
          <span>/</span>
          <span className="font-mono">{shortId(run.id)}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h2 className="text-base font-semibold text-ink">
            {formatSkill(run.skillSlug)}
          </h2>
          <StatusBadge status={run.status} />
          {run.skillSlug === "chat-turn" ? (
            <ChatRunActionButtons
              runId={run.id}
              canCancel={run.status === "queued" || run.status === "running"}
              canRetry={run.status === "failed" || run.status === "canceled"}
              canResume={run.status === "queued" || run.status === "running"}
            />
          ) : canRetryWorkflowRun(run.status) ? (
            <RetryRunButton runId={run.id} modelId={run.modelId} />
          ) : null}
          <Link
            href={`/chat?inspectRun=${run.id}`}
            className="inline-flex h-8 items-center rounded-md border border-hairline bg-canvas px-2.5 text-xs font-medium text-ink hover:bg-subtle"
          >
            Open inspector
          </Link>
        </div>
        <p className="mt-1 text-xs text-muted">
          Stored workflow output, tool activity, and audit trail for this run.
        </p>
      </div>

      <div className="grid gap-3 px-6 pb-5 md:grid-cols-5">
        <Metric label="Started" value={formatNullableDate(run.startedAt)} />
        <Metric
          label="Duration"
          value={
            run.startedAt && run.completedAt
              ? formatDuration(run.startedAt, run.completedAt)
              : run.startedAt
                ? "Running"
                : "Not started"
          }
        />
        <Metric label="Runtime" value={output.runtime ?? run.runtime ?? "n/a"} />
        <Metric
          label="First token"
          value={formatNullableMs(output.metrics?.requestToFirstTokenMs)}
        />
        <Metric label="Tokens" value={tokenText} />
      </div>

      <div className="grid gap-6 px-6 pb-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          {run.error ? (
            <section>
              <h3 className="mb-2 text-sm font-semibold text-ink">Error</h3>
              <div className="whitespace-pre-wrap rounded-md border border-danger/20 bg-danger-bg px-3 py-2 font-mono text-xs text-danger [overflow-wrap:anywhere]">
                {run.error}
              </div>
            </section>
          ) : null}

          <section>
            <h3 className="mb-2 text-sm font-semibold text-ink">
              {primaryOutputLabel}
            </h3>
            {primaryOutput ? (
              <div className="rounded-md border border-hairline bg-surface px-4 py-3">
                <MessageBubble
                  role="assistant"
                  content={primaryOutput}
                  modelId={output.modelId ?? run.modelId ?? undefined}
                  toolCalls={toolCalls}
                  toolResults={toolResults}
                  activityEvents={
                    activityEvents.length > 0 ? activityEvents : undefined
                  }
                  sources={output.sources}
                />
              </div>
            ) : (
              <div className="rounded-md border border-hairline px-4 py-6 text-center text-xs text-muted">
                No assistant output was stored for this run.
              </div>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-ink">
              Activity
            </h3>
            {runEventRows.length === 0 ? (
              <div className="rounded-md border border-hairline px-4 py-6 text-center text-xs text-muted">
                No run activity events are stored yet.
              </div>
            ) : (
              <div className="divide-y divide-hairline rounded-md border border-hairline bg-surface">
                {runEventRows.map((event) => (
                  <div key={event.id} className="px-3 py-2 text-xs">
                    <div className="flex min-w-0 items-center gap-2">
                      <StatusDot status={event.status} />
                      <span className="font-medium text-ink">
                        {event.label}
                      </span>
                      <span className="ml-auto shrink-0 text-muted">
                        {formatDateTime(event.occurredAt)}
                      </span>
                    </div>
                    <div className="mt-1 font-mono text-2xs text-muted">
                      {[event.eventType, event.provider, event.toolName]
                        .filter(Boolean)
                        .join(" / ")}
                    </div>
                    {event.error ? (
                      <div className="mt-1 line-clamp-3 font-mono text-2xs text-danger">
                        {event.error}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-ink">
              Stored Tool Data
            </h3>
            <details className="rounded-md border border-hairline bg-surface px-3 py-2 text-xs text-muted">
              <summary className="cursor-pointer list-none marker:hidden">
                Redacted calls and results
              </summary>
              <pre className="mt-2 max-h-[28rem] overflow-auto border-t border-hairline pt-2 font-mono text-2xs leading-relaxed text-ink [overflow-wrap:anywhere]">
                {JSON.stringify({ toolCalls, toolResults }, null, 2)}
              </pre>
            </details>
          </section>
        </div>

        <aside className="space-y-6">
          <section>
            <h3 className="mb-2 text-sm font-semibold text-ink">Run</h3>
            <dl className="divide-y divide-hairline rounded-md border border-hairline text-xs">
              <DetailRow
                label="User"
                value={run.actorName ?? run.actorEmail ?? "Unknown"}
              />
              <DetailRow label="Trigger" value={run.triggerType} />
              {run.eventTriggerId ? (
                <DetailRow
                  label="Event trigger"
                  value={shortId(run.eventTriggerId)}
                />
              ) : null}
              {run.eventDeliveryId ? (
                <DetailRow label="GitHub delivery" value={run.eventDeliveryId} />
              ) : null}
              {retryInfo ? (
                <DetailLinkRow
                  label="Retry of"
                  href={`/admin/runs/${retryInfo.retryOfRunId}`}
                  value={shortId(retryInfo.retryOfRunId)}
                />
              ) : null}
              <DetailRow
                label="Model"
                value={output.modelId ?? run.modelId ?? "n/a"}
              />
              {output.requestedModelId &&
              output.requestedModelId !== output.modelId ? (
                <DetailRow label="Requested" value={output.requestedModelId} />
              ) : null}
              {output.providerModelId ? (
                <DetailRow label="Provider model" value={output.providerModelId} />
              ) : null}
              {output.modelSelection?.reason ? (
                <DetailRow
                  label="Model policy"
                  value={output.modelSelection.reason}
                />
              ) : null}
              {output.runtimeTarget ? (
                <DetailRow label="Target" value={output.runtimeTarget} />
              ) : null}
              {output.errorDetails?.[0]?.category ? (
                <DetailRow
                  label="Error category"
                  value={output.errorDetails[0].category}
                />
              ) : null}
              {output.providerRun?.executionMode ? (
                <DetailRow
                  label="Mode"
                  value={output.providerRun.executionMode}
                />
              ) : null}
              {output.providerRun?.providerRunId ? (
                <DetailRow
                  label="Provider run"
                  value={shortId(output.providerRun.providerRunId)}
                />
              ) : null}
              <DetailRow label="Created" value={formatDateTime(run.createdAt)} />
              <DetailRow label="Updated" value={formatDateTime(run.updatedAt)} />
            </dl>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-ink">
              Timing
            </h3>
            <dl className="divide-y divide-hairline rounded-md border border-hairline text-xs">
              <DetailRow
                label="1st token"
                value={formatNullableMs(output.metrics?.requestToFirstTokenMs)}
              />
              <DetailRow
                label="Provider"
                value={formatNullableMs(output.metrics?.requestToProviderMs)}
              />
              <DetailRow
                label="Token gap"
                value={formatNullableMs(output.metrics?.providerToFirstTokenMs)}
              />
              <DetailRow
                label="Complete"
                value={formatNullableMs(output.metrics?.requestToCompletedMs)}
              />
            </dl>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-ink">Prompt</h3>
            <div className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-hairline bg-surface px-3 py-2 text-xs text-muted [overflow-wrap:anywhere]">
              {prompt ?? "No input prompt was stored."}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-ink">
              Context Debug
            </h3>
            <DebugJsonBlock
              value={contextDebug}
              emptyLabel="No context receipt or route receipt is stored for this run."
            />
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-ink">
              Recommendations
            </h3>
            <DebugJsonBlock
              value={
                output.recommendations && output.recommendations.length > 0
                  ? output.recommendations
                  : undefined
              }
              emptyLabel="No recommendation candidates were stored for this run."
            />
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-ink">
              Audit Events
            </h3>
            <div className="rounded-md border border-hairline">
              {auditRows.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted">
                  No audit events are linked to this run.
                </div>
              ) : (
                <div className="divide-y divide-hairline">
                  {auditRows.map((row) => (
                    <div key={row.id} className="px-3 py-2 text-xs">
                      <div className="flex items-center gap-2">
                        <StatusDot status={row.status} />
                        <span className="font-medium text-ink">
                          {formatAction(row.actionType)}
                        </span>
                        <span className="ml-auto text-muted">
                          {formatDateTime(row.createdAt)}
                        </span>
                      </div>
                      <div className="mt-1 font-mono text-2xs text-muted">
                        {[row.provider, row.toolName]
                          .filter(Boolean)
                          .join(" / ") ||
                          "platform"}
                      </div>
                      {row.error ? (
                        <div className="mt-1 line-clamp-3 font-mono text-2xs text-danger">
                          {row.error}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

function parseRunOutput(value: unknown): RunOutput {
  if (!isRecord(value)) return {};
  return {
    briefingMarkdown:
      typeof value.briefingMarkdown === "string"
        ? value.briefingMarkdown
        : undefined,
    assistantText:
      typeof value.assistantText === "string" ? value.assistantText : undefined,
    toolCalls: Array.isArray(value.toolCalls)
      ? (value.toolCalls as PersistedToolCall[])
      : undefined,
    toolResults: Array.isArray(value.toolResults)
      ? (value.toolResults as PersistedToolResult[])
      : undefined,
    tokensIn: typeof value.tokensIn === "number" ? value.tokensIn : undefined,
    tokensOut: typeof value.tokensOut === "number" ? value.tokensOut : undefined,
    modelId: typeof value.modelId === "string" ? value.modelId : undefined,
    requestedModelId:
      typeof value.requestedModelId === "string"
        ? value.requestedModelId
        : undefined,
    providerModelId:
      typeof value.providerModelId === "string"
        ? value.providerModelId
        : undefined,
    modelSelection: isRecord(value.modelSelection)
      ? {
          reason:
            typeof value.modelSelection.reason === "string"
              ? value.modelSelection.reason
              : undefined,
        }
      : undefined,
    runtime: typeof value.runtime === "string" ? value.runtime : undefined,
    runtimeTarget:
      typeof value.runtimeTarget === "string" ? value.runtimeTarget : undefined,
    recommendations: Array.isArray(value.recommendations)
      ? (value.recommendations as PersistedRecommendation[])
      : undefined,
    sources: parseAssistantSources(value.sources),
    errorDetails: Array.isArray(value.errorDetails)
      ? value.errorDetails
          .filter(isRecord)
          .map((detail) => ({
            code: typeof detail.code === "string" ? detail.code : undefined,
            category:
              typeof detail.category === "string" ? detail.category : undefined,
            rawMessage:
              typeof detail.rawMessage === "string"
                ? detail.rawMessage
                : undefined,
          }))
      : undefined,
    metrics: parseRunTimingMetrics(value.metrics),
    providerRun: isRecord(value.providerRun)
      ? {
          providerAgentId:
            typeof value.providerRun.providerAgentId === "string"
              ? value.providerRun.providerAgentId
              : undefined,
          providerRunId:
            typeof value.providerRun.providerRunId === "string"
              ? value.providerRun.providerRunId
              : undefined,
          executionMode:
            typeof value.providerRun.executionMode === "string"
              ? value.providerRun.executionMode
              : undefined,
        }
      : undefined,
  };
}

function parseRunTimingMetrics(
  value: unknown,
): RunTimingMetrics | undefined {
  if (!isRecord(value)) return undefined;
  return {
    requestStartedAt:
      typeof value.requestStartedAt === "string"
        ? value.requestStartedAt
        : undefined,
    inlineStartedAt:
      typeof value.inlineStartedAt === "string"
        ? value.inlineStartedAt
        : undefined,
    contextReadyAt:
      typeof value.contextReadyAt === "string" ? value.contextReadyAt : undefined,
    providerStartedAt:
      typeof value.providerStartedAt === "string"
        ? value.providerStartedAt
        : undefined,
    firstTokenAt:
      typeof value.firstTokenAt === "string" ? value.firstTokenAt : undefined,
    completedAt:
      typeof value.completedAt === "string" ? value.completedAt : undefined,
    requestToInlineMs:
      typeof value.requestToInlineMs === "number"
        ? value.requestToInlineMs
        : undefined,
    inlineToContextReadyMs:
      typeof value.inlineToContextReadyMs === "number"
        ? value.inlineToContextReadyMs
        : undefined,
    requestToProviderMs:
      typeof value.requestToProviderMs === "number"
        ? value.requestToProviderMs
        : undefined,
    providerToFirstTokenMs:
      typeof value.providerToFirstTokenMs === "number"
        ? value.providerToFirstTokenMs
        : undefined,
    requestToFirstTokenMs:
      typeof value.requestToFirstTokenMs === "number"
        ? value.requestToFirstTokenMs
        : undefined,
    requestToCompletedMs:
      typeof value.requestToCompletedMs === "number"
        ? value.requestToCompletedMs
        : undefined,
  };
}

function parsePrompt(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.prompt === "string" ? value.prompt : undefined;
}

function parseRunContextDebug(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const debug: Record<string, unknown> = {};
  for (const key of [
    "runtimeRoute",
    "routeReceipt",
    "contextReceipt",
    "mcpProviders",
    "accountConnectedMcpProviders",
    "approvedMcpProviders",
    "deniedMcpProviders",
    "uploadedFiles",
  ]) {
    if (value[key] !== undefined) debug[key] = value[key];
  }
  return Object.keys(debug).length > 0 ? debug : undefined;
}

function parseRetryInfo(value: unknown): { retryOfRunId: string } | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.retryOfRunId === "string"
    ? { retryOfRunId: value.retryOfRunId }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-hairline bg-surface px-3 py-2">
      <div className="text-2xs uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-semibold text-ink">{value}</div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2 px-3 py-2">
      <dt className="text-muted">{label}</dt>
      <dd className="truncate text-ink">{value}</dd>
    </div>
  );
}

function DetailLinkRow({
  label,
  href,
  value,
}: {
  label: string;
  href: string;
  value: string;
}) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2 px-3 py-2">
      <dt className="text-muted">{label}</dt>
      <dd className="truncate">
        <Link
          href={href}
          className="text-ink underline-offset-2 hover:underline"
        >
          {value}
        </Link>
      </dd>
    </div>
  );
}

function DebugJsonBlock({
  value,
  emptyLabel,
}: {
  value: unknown;
  emptyLabel: string;
}) {
  if (value === undefined || value === null) {
    return (
      <div className="rounded-md border border-hairline px-3 py-4 text-xs text-muted">
        {emptyLabel}
      </div>
    );
  }
  return (
    <details className="rounded-md border border-hairline bg-surface px-3 py-2 text-xs text-muted">
      <summary className="cursor-pointer list-none marker:hidden">
        Inspect JSON
      </summary>
      <pre className="mt-2 max-h-80 overflow-auto border-t border-hairline pt-2 font-mono text-2xs leading-relaxed text-ink [overflow-wrap:anywhere]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "succeeded"
      ? "bg-success"
      : status === "failed"
        ? "bg-danger"
        : status === "running" || status === "started" || status === "pending"
          ? "animate-pulse bg-info"
          : status === "denied"
            ? "bg-warning"
            : "bg-muted";
  return <span className={`h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

function StatusBadge({ status }: { status: string }) {
  const classes =
    status === "succeeded"
      ? "bg-success-bg text-success"
      : status === "failed"
        ? "bg-danger-bg text-danger"
        : status === "running"
          ? "bg-info-bg text-info"
          : "bg-subtle text-muted";
  return (
    <span
      className={`inline-flex rounded px-2 py-0.5 text-2xs uppercase tracking-wider ${classes}`}
    >
      {status}
    </span>
  );
}

function formatSkill(value: string | null) {
  if (value === "developer-briefing") return "Developer Briefing";
  return value
    ? value
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ")
    : "Workflow run";
}

function formatAction(value: string) {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function shortId(value: string) {
  return value.slice(0, 8);
}

function formatNullableDate(value: Date | null) {
  return value ? formatDateTime(value) : "n/a";
}

function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function formatDuration(startedAt: Date, completedAt: Date) {
  const ms = Math.max(0, completedAt.getTime() - startedAt.getTime());
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function formatNullableMs(value: number | undefined) {
  if (typeof value !== "number") return "n/a";
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
}
