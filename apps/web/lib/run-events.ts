import type { RunEvent } from "@ai-workspace/db";
import { type Database, runEvents } from "@ai-workspace/db";
import { desc, eq } from "drizzle-orm";
import type { AgentActivityEvent, ActivityState } from "@/lib/activity-events";
import { categorizeTool, buildToolActivityEvents } from "@/lib/activity-events";
import {
  type PersistedToolCall,
  type PersistedToolResult,
} from "@/lib/tool-events";
import {
  redactErrorText,
  redactProviderToolError,
  redactProviderToolPayload,
  redactTracePayload,
  redactToolPayload,
} from "@/lib/tool-redaction";

export type RunEventStatus = "info" | "pending" | "succeeded" | "failed";

export interface AppendRunEventInput {
  db: Database;
  runId: string;
  sequence: number;
  eventType: string;
  status?: RunEventStatus;
  label: string;
  provider?: string | null;
  toolName?: string | null;
  toolCallId?: string | null;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
  redactionProfile?: "tool" | "trace";
}

export async function appendRunEvent({
  db,
  runId,
  sequence,
  eventType,
  status = "info",
  label,
  provider,
  toolName,
  toolCallId,
  input,
  output,
  error,
  metadata,
  occurredAt,
  redactionProfile = "tool",
}: AppendRunEventInput): Promise<void> {
  const redact =
    redactionProfile === "trace" ? redactTracePayload : redactToolPayload;
  await db.insert(runEvents).values({
    runId,
    sequence,
    eventType,
    status,
    label,
    provider: provider ?? null,
    toolName: toolName ?? null,
    toolCallId: toolCallId ?? null,
    input:
      input === undefined
        ? null
        : (redact(input) as Record<string, unknown> | null),
    output: output === undefined ? null : redact(output),
    error: error === undefined ? null : redactErrorText(error),
    metadata:
      metadata === undefined
        ? null
        : redactionProfile === "trace"
          ? (redactTracePayload(metadata) as Record<string, unknown>)
          : metadata,
    occurredAt: occurredAt ?? new Date(),
  });
}

export async function nextRunEventSequence(
  db: Database,
  runId: string,
): Promise<number> {
  const rows = await db
    .select({ sequence: runEvents.sequence })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(desc(runEvents.sequence))
    .limit(1);
  return (rows[0]?.sequence ?? 0) + 1;
}

export async function appendRunEventWithNextSequence(
  input: Omit<AppendRunEventInput, "sequence">,
): Promise<void> {
  await appendRunEvent({
    ...input,
    sequence: await nextRunEventSequence(input.db, input.runId),
  });
}

/**
 * Best-effort append: run-event bookkeeping must never kill a turn. Failures
 * are logged under `[<logTag>]` and swallowed.
 */
export async function appendRunEventBestEffort(
  logTag: string,
  input: Omit<AppendRunEventInput, "sequence">,
): Promise<void> {
  try {
    await appendRunEventWithNextSequence(input);
  } catch (err) {
    process.stderr.write(
      `[${logTag}] ${JSON.stringify({
        runId: input.runId,
        eventType: input.eventType,
        message: err instanceof Error ? err.message : String(err),
      })}\n`,
    );
  }
}

export async function appendToolCallRunEvent({
  db,
  runId,
  sequence,
  call,
}: {
  db: Database;
  runId: string;
  sequence: number;
  call: PersistedToolCall;
}): Promise<void> {
  const activity = buildToolActivityEvents([call], [])[0];
  await appendRunEvent({
    db,
    runId,
    sequence,
    eventType: "tool_call",
    status: "pending",
    label: activity?.label ?? "Started a tool step",
    provider: call.provider,
    toolName: call.toolName,
    toolCallId: call.id,
    input: redactProviderToolPayload({
      provider: call.provider,
      toolName: call.toolName,
      direction: "input",
      value: call.input,
    }),
    metadata: { rawToolName: call.name },
    occurredAt: new Date(call.startedAt),
  });
}

export async function appendToolResultRunEvent({
  db,
  runId,
  sequence,
  call,
  result,
}: {
  db: Database;
  runId: string;
  sequence: number;
  call?: PersistedToolCall;
  result: PersistedToolResult;
}): Promise<void> {
  const activity = buildToolActivityEvents(
    call ? [call] : [],
    [result],
  )[0];
  await appendRunEvent({
    db,
    runId,
    sequence,
    eventType: "tool_result",
    status: result.isError ? "failed" : "succeeded",
    label:
      activity?.label ??
      (result.isError ? "Tool step needs attention" : "Finished a step"),
    provider: call?.provider ?? result.provider ?? null,
    toolName: call?.toolName ?? result.toolName ?? null,
    toolCallId: result.toolCallId,
    output: redactProviderToolPayload({
      provider: call?.provider ?? result.provider,
      toolName: call?.toolName ?? result.toolName,
      direction: "output",
      value: result.output,
    }),
    error: result.isError
      ? redactProviderToolError(
          call?.provider ?? result.provider,
          result.output,
        )
      : undefined,
    metadata: {
      ...(call?.name || result.name
        ? { rawToolName: call?.name ?? result.name }
        : {}),
    },
    occurredAt: new Date(result.completedAt),
  });
}

export function runEventsToActivityEvents(
  events: readonly (Pick<
    RunEvent,
    | "id"
    | "sequence"
    | "eventType"
    | "status"
    | "label"
    | "toolCallId"
    | "error"
    | "occurredAt"
  > &
    Partial<Pick<RunEvent, "input" | "output" | "metadata">> & {
    eventType?: string;
    provider?: string | null;
    toolName?: string | null;
  })[],
): AgentActivityEvent[] {
  const latestToolEvents = new Map<string, AgentActivityEvent>();
  const generalEvents: AgentActivityEvent[] = [];
  // Trace-lane rows (#386) share run_events with the receipt lane; they are
  // admin diagnostics, not user-visible work, and previously fell through
  // to the "progress" category as phantom rows (#359).
  const sortedEvents = [...events]
    .filter((event) => !isTraceRunEvent(event.eventType))
    .sort(compareRunEvents);
  let terminalSequence: number | null = null;
  for (const event of sortedEvents) {
    if (isTerminalRunEvent(event.eventType)) {
      terminalSequence = event.sequence;
    }
  }

  for (const event of sortedEvents) {
    const state = normalizeActivityState(event, terminalSequence);
    const activity = {
      id: event.toolCallId ?? event.id,
      state,
      label: runEventActivityLabel(event),
      ...(event.error
        ? { detail: event.error }
        : runEventDetail(event) ? { detail: runEventDetail(event) } : {}),
      at: event.occurredAt.toISOString(),
      category: event.toolCallId
        ? categorizeTool(event.provider, event.toolName)
        : categoryForRunEvent(event),
    } satisfies AgentActivityEvent;

    if (event.toolCallId) {
      latestToolEvents.set(event.toolCallId, activity);
    } else {
      generalEvents.push(activity);
    }
  }

  return [...generalEvents, ...latestToolEvents.values()].sort((a, b) =>
    (a.at ?? "").localeCompare(b.at ?? ""),
  );
}

function compareRunEvents(
  a: Pick<RunEvent, "sequence" | "occurredAt" | "id">,
  b: Pick<RunEvent, "sequence" | "occurredAt" | "id">,
): number {
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  const byTime = a.occurredAt.getTime() - b.occurredAt.getTime();
  return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
}

function toActivityState(status: string): ActivityState {
  if (status === "failed") return "failed";
  if (status === "pending") return "pending";
  return "succeeded";
}

function normalizeActivityState(
  event: Pick<RunEvent, "sequence" | "status" | "toolCallId"> & {
    eventType?: string;
  },
  terminalSequence: number | null,
): ActivityState {
  if (event.eventType === "run_canceled") {
    return "succeeded";
  }
  if (
    terminalSequence !== null &&
    event.sequence < terminalSequence &&
    !event.toolCallId &&
    event.status === "pending"
  ) {
    return "succeeded";
  }
  return toActivityState(event.status);
}

function isTerminalRunEvent(eventType?: string): boolean {
  return (
    eventType === "run_completed" ||
    eventType === "run_failed" ||
    eventType === "run_canceled" ||
    eventType === "worker_stopped_after_cancel"
  );
}

/**
 * "Edited report.html · +14 −3" / "Created 2 files" from the artifact
 * summaries stamped on the workspace_artifacts_created event (#359). Only
 * structured metadata is used — safe filenames, mint-time diff counts.
 */
function artifactsCreatedLabel(metadata: unknown): string | null {
  if (!isRecord(metadata) || !Array.isArray(metadata.artifacts)) return null;
  const artifacts = metadata.artifacts.filter(isRecord);
  if (artifacts.length === 0) return null;

  let added = 0;
  let removed = 0;
  let approximate = false;
  let edits = 0;
  for (const artifact of artifacts) {
    if (artifact.supersedesArtifactId) edits++;
    const meta = isRecord(artifact.metadata) ? artifact.metadata : null;
    const delta = meta && isRecord(meta.lineDelta) ? meta.lineDelta : null;
    if (delta) {
      added += numberValue(delta.added) ?? 0;
      removed += numberValue(delta.removed) ?? 0;
      if (delta.approximate === true) approximate = true;
    }
  }

  const verb = edits === artifacts.length && edits > 0 ? "Edited" : "Created";
  const noun =
    artifacts.length === 1
      ? typeof artifacts[0]!.filename === "string"
        ? (artifacts[0]!.filename as string)
        : "1 file"
      : `${artifacts.length} files`;
  const deltaPart =
    added + removed > 0
      ? ` · ${approximate ? "~" : ""}+${added} −${removed}`
      : "";
  return `${verb} ${noun}${deltaPart}`;
}

function isTraceRunEvent(eventType?: string): boolean {
  return (
    eventType === "provider_context_snapshot" ||
    eventType === "provider_reasoning" ||
    eventType === "provider_response_metadata"
  );
}

/**
 * Deterministic run phase for the live footer (#359): derived only from
 * structured events, never model narration. Later events win; tool events
 * dominate until something later supersedes them.
 */
export type RunPhase =
  | "starting"
  | "reading"
  | "planning"
  | "using tools"
  | "editing"
  | "validating"
  | "publishing"
  | "finalizing"
  | "done";

const PHASE_BY_EVENT: Record<string, RunPhase> = {
  run_queued: "starting",
  run_started: "starting",
  worker_claimed: "starting",
  worker_started: "starting",
  inline_runtime_started: "starting",
  uploaded_files_stored: "reading",
  uploaded_files_replayed: "reading",
  context_pack_assembled: "reading",
  provider_run_started: "planning",
  first_token_streamed: "finalizing",
  tool_call: "using tools",
  tool_result: "using tools",
  workspace_artifacts_created: "editing",
  app_draft_versions_created: "publishing",
  run_completed: "done",
  run_failed: "done",
  run_canceled: "done",
  worker_stopped_after_cancel: "done",
};

export function derivePhaseFromRunEvents(
  events: readonly { eventType?: string; sequence: number }[],
): RunPhase {
  let phase: RunPhase = "starting";
  let phaseSequence = -1;
  for (const event of events) {
    if (isTraceRunEvent(event.eventType)) continue;
    const mapped = event.eventType ? PHASE_BY_EVENT[event.eventType] : undefined;
    if (!mapped) continue;
    if (event.sequence >= phaseSequence) {
      phase = mapped;
      phaseSequence = event.sequence;
    }
  }
  return phase;
}

function categoryForRunEvent(event: {
  eventType?: string;
  label: string;
}): AgentActivityEvent["category"] {
  const value = `${event.eventType ?? ""} ${event.label}`.toLowerCase();
  if (/context_pack_assembled|vault|context pack/.test(value)) return "context";
  if (/upload|artifact|workspace/.test(value)) return "workspace";
  return "progress";
}

function runEventActivityLabel(event: {
  eventType?: string;
  label: string;
  metadata?: unknown;
}): string {
  if (event.eventType === "workspace_artifacts_created") {
    return artifactsCreatedLabel(event.metadata) ?? event.label;
  }
  if (event.eventType !== "context_pack_assembled") return event.label;
  const receipt = contextReceiptFromMetadata(event.metadata);
  const vault = isRecord(receipt?.vault) ? receipt.vault : null;
  const checked = vault?.checked === true;
  const injected = vault?.injected === true;
  const itemCount = numberValue(vault?.approvedMemoryItems) ?? 0;
  if (checked) {
    if (injected && itemCount > 0) {
      return `Checked Vault · ${itemCount} approved ${itemCount === 1 ? "memory" : "memories"}`;
    }
    return "Checked Vault · no approved memory";
  }
  return "Checked context pack";
}

function runEventDetail(event: {
  eventType?: string;
  input?: unknown;
  output?: unknown;
  metadata?: unknown;
  provider?: string | null;
  toolName?: string | null;
}): string | undefined {
  const metadata = isRecord(event.metadata) ? event.metadata : null;
  if (
    event.eventType === "uploaded_files_stored" ||
    event.eventType === "uploaded_files_replayed"
  ) {
    const files = Array.isArray(metadata?.uploadedFiles)
      ? metadata.uploadedFiles
      : [];
    const names = files
      .map((file) =>
        isRecord(file) && typeof file.name === "string" ? file.name : null,
      )
      .filter((name): name is string => Boolean(name));
    return names.length > 0 ? names.join("\n") : undefined;
  }

  if (event.eventType === "context_pack_assembled") {
    const receipt = contextReceiptFromMetadata(event.metadata);
    const vault = isRecord(receipt?.vault) ? receipt.vault : null;
    const work = isRecord(receipt?.work) ? receipt.work : null;
    const tools = isRecord(receipt?.tools) ? receipt.tools : null;
    const contextItems = Array.isArray(receipt?.contextItems)
      ? receipt.contextItems
      : [];
    const parts = [
      vaultDetail(vault),
      boolLabel(work?.artifactContextInjected, "artifact context"),
      boolLabel(work?.uploadedFilesInjected, "uploaded files"),
      Array.isArray(tools?.mounted) && tools.mounted.length > 0
        ? `mounted tools: ${tools.mounted.join(", ")}`
        : null,
      summarizeContextSources(contextItems),
    ].filter(Boolean);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  const payload = event.output ?? event.input;
  if (payload !== undefined && payload !== null) {
    return summarizePayload(payload);
  }

  if (event.provider || event.toolName) {
    return [event.provider, event.toolName].filter(Boolean).join(" · ");
  }
  return undefined;
}

function contextReceiptFromMetadata(metadata: unknown): Record<string, unknown> | null {
  const record = isRecord(metadata) ? metadata : null;
  return isRecord(record?.contextReceipt) ? record.contextReceipt : null;
}

function vaultDetail(vault: Record<string, unknown> | null): string | null {
  if (!vault) return null;
  if (vault.checked !== true) return "Vault not checked";
  const itemCount = numberValue(vault.approvedMemoryItems) ?? 0;
  const chars = numberValue(vault.approvedMemoryChars) ?? 0;
  if (vault.injected === true && itemCount > 0) {
    return `Vault checked: ${itemCount} approved ${itemCount === 1 ? "memory" : "memories"} injected (${chars} chars)`;
  }
  return "Vault checked: no approved memory injected";
}

function boolLabel(value: unknown, label: string): string | null {
  return value === true ? label : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function summarizePayload(value: unknown): string | undefined {
  try {
    const text =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);
    const compact = text.trim();
    if (!compact) return undefined;
    return compact.length > 600 ? `${compact.slice(0, 599)}...` : compact;
  } catch {
    return undefined;
  }
}

function summarizeContextSources(items: unknown[]): string | null {
  const sources = new Map<string, { injected: number; total: number }>();
  for (const item of items) {
    if (!isRecord(item) || typeof item.source !== "string") continue;
    const current = sources.get(item.source) ?? { injected: 0, total: 0 };
    current.total += 1;
    if (item.injected === true) current.injected += 1;
    sources.set(item.source, current);
  }
  if (sources.size === 0) return null;
  return `context sources: ${[...sources.entries()]
    .map(([source, count]) => `${source} ${count.injected}/${count.total}`)
    .join(", ")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
