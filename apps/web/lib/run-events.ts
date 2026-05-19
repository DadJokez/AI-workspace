import type { RunEvent } from "@ai-workspace/db";
import { type Database, runEvents } from "@ai-workspace/db";
import { desc, eq } from "drizzle-orm";
import type { AgentActivityEvent, ActivityState } from "@/lib/activity-events";
import { buildToolActivityEvents } from "@/lib/activity-events";
import {
  type PersistedToolCall,
  type PersistedToolResult,
} from "@/lib/tool-events";
import {
  redactErrorText,
  redactToolPayload,
} from "@/lib/tool-redaction";

export type RunEventStatus = "info" | "pending" | "succeeded" | "failed";

export interface AppendRunEventInput {
  db: Database;
  recipeRunId: string;
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
  recipeRunId,
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
    recipeRunId,
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
    .where(eq(runEvents.recipeRunId, input.recipeRunId))
    .orderBy(desc(runEvents.sequence))
    .limit(1);
  await appendRunEvent({
    ...input,
    sequence: (rows[0]?.sequence ?? 0) + 1,
  });
}

export async function appendToolCallRunEvent({
  db,
  recipeRunId,
  sequence,
  call,
}: {
  db: Database;
  recipeRunId: string;
  sequence: number;
  call: PersistedToolCall;
}): Promise<void> {
  const activity = buildToolActivityEvents([call], [])[0];
  await appendRunEvent({
    db,
    recipeRunId,
    sequence,
    eventType: "tool_call",
    status: "pending",
    label: activity?.label ?? "Started a tool step",
    provider: call.provider,
    toolName: call.toolName,
    toolCallId: call.id,
    input: call.input,
    metadata: { rawToolName: call.name },
    occurredAt: new Date(call.startedAt),
  });
}

export async function appendToolResultRunEvent({
  db,
  recipeRunId,
  sequence,
  call,
  result,
}: {
  db: Database;
  recipeRunId: string;
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
    recipeRunId,
    sequence,
    eventType: "tool_result",
    status: result.isError ? "failed" : "succeeded",
    label:
      activity?.label ??
      (result.isError ? "Tool step needs attention" : "Finished a step"),
    provider: call?.provider ?? result.provider ?? null,
    toolName: call?.toolName ?? result.toolName ?? null,
    toolCallId: result.toolCallId,
    output: result.output,
    error: result.isError ? result.output : undefined,
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
  > & { eventType?: string })[],
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
      label: event.label,
      ...(event.error ? { detail: event.error } : {}),
      at: event.occurredAt.toISOString(),
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
