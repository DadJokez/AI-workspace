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
}: AppendRunEventInput): Promise<void> {
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
        : (redactToolPayload(input) as Record<string, unknown> | null),
    output: output === undefined ? null : redactToolPayload(output),
    error: error === undefined ? null : redactErrorText(error),
    metadata: metadata ?? null,
    occurredAt: occurredAt ?? new Date(),
  });
}

export async function appendRunEventWithNextSequence(
  input: Omit<AppendRunEventInput, "sequence">,
): Promise<void> {
  const rows = await input.db
    .select({ sequence: runEvents.sequence })
    .from(runEvents)
    .where(eq(runEvents.runId, input.runId))
    .orderBy(desc(runEvents.sequence))
    .limit(1);
  await appendRunEvent({
    ...input,
    sequence: (rows[0]?.sequence ?? 0) + 1,
  });
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
  const sortedEvents = [...events].sort(compareRunEvents);
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
  if (event.eventType === "uploaded_files_stored") {
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
      boolLabel(work?.threadSummaryInjected, "thread summary"),
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
