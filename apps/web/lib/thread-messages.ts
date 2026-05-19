import {
  chatMessages,
  type Database,
  recipeRuns,
  runEvents,
} from "@ai-workspace/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { AgentActivityEvent } from "@/lib/activity-events";
import { runEventsToActivityEvents } from "@/lib/run-events";
import type {
  PersistedToolCall,
  PersistedToolResult,
} from "@/lib/tool-events";

interface ChatRunOutput {
  assistantMessageId?: string;
  assistantText?: string;
  toolCalls?: PersistedToolCall[];
  toolResults?: PersistedToolResult[];
}

export interface ThreadMessageWithActivity {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  modelId: string | null;
  runtime: string | null;
  toolCalls: PersistedToolCall[] | null;
  toolResults: PersistedToolResult[] | null;
  activityEvents?: AgentActivityEvent[];
  pending?: boolean;
  status?: string;
  createdAt: Date;
}

export async function loadThreadMessagesWithRunActivity({
  db,
  threadId,
}: {
  db: Database;
  threadId: string;
}): Promise<ThreadMessageWithActivity[]> {
  const [messageRows, runRows] = await Promise.all([
    db
      .select({
        id: chatMessages.id,
        role: chatMessages.role,
        content: chatMessages.content,
        modelId: chatMessages.modelId,
        runtime: chatMessages.runtime,
        toolCalls: chatMessages.toolCalls,
        toolResults: chatMessages.toolResults,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId))
      .orderBy(asc(chatMessages.createdAt)),
    db
      .select({
        id: recipeRuns.id,
        status: recipeRuns.status,
        modelId: recipeRuns.modelId,
        runtime: recipeRuns.runtime,
        outputs: recipeRuns.outputs,
        startedAt: recipeRuns.startedAt,
        createdAt: recipeRuns.createdAt,
      })
      .from(recipeRuns)
      .where(
        and(
          eq(recipeRuns.threadId, threadId),
          eq(recipeRuns.recipeSlug, "chat-turn"),
        ),
      )
      .orderBy(asc(recipeRuns.createdAt)),
  ]);

  const runIds = runRows.map((run) => run.id);
  const eventRows =
    runIds.length > 0
      ? await db
          .select({
            id: runEvents.id,
            recipeRunId: runEvents.recipeRunId,
            sequence: runEvents.sequence,
            status: runEvents.status,
            label: runEvents.label,
            toolCallId: runEvents.toolCallId,
            error: runEvents.error,
            occurredAt: runEvents.occurredAt,
          })
          .from(runEvents)
          .where(inArray(runEvents.recipeRunId, runIds))
          .orderBy(asc(runEvents.sequence), asc(runEvents.occurredAt))
      : [];

  const eventsByRunId = new Map<string, typeof eventRows>();
  for (const event of eventRows) {
    const existing = eventsByRunId.get(event.recipeRunId) ?? [];
    existing.push(event);
    eventsByRunId.set(event.recipeRunId, existing);
  }

  const activityByAssistantMessageId = new Map<string, AgentActivityEvent[]>();
  const activeRunMessages: ThreadMessageWithActivity[] = [];

  for (const run of runRows) {
    const output = parseChatRunOutput(run.outputs);
    const activityEvents = runEventsToActivityEvents(
      eventsByRunId.get(run.id) ?? [],
    );
    if (output.assistantMessageId) {
      if (activityEvents.length > 0) {
        activityByAssistantMessageId.set(
          output.assistantMessageId,
          activityEvents,
        );
      }
      continue;
    }
    if (run.status !== "queued" && run.status !== "running") continue;

    activeRunMessages.push({
      id: `run:${run.id}`,
      role: "assistant",
      content: output.assistantText ?? "",
      modelId: run.modelId,
      runtime: run.runtime,
      toolCalls: output.toolCalls ?? null,
      toolResults: output.toolResults ?? null,
      activityEvents,
      pending: true,
      status:
        latestActivityLabel(activityEvents) ??
        (run.status === "queued" ? "Queued..." : "Working..."),
      createdAt: run.startedAt ?? run.createdAt,
    });
  }

  const messages = messageRows.map((message) => ({
    ...message,
    toolCalls: toToolCalls(message.toolCalls),
    toolResults: toToolResults(message.toolResults),
    activityEvents: activityByAssistantMessageId.get(message.id),
  }));

  return [...messages, ...activeRunMessages].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
}

function parseChatRunOutput(value: unknown): ChatRunOutput {
  if (!isRecord(value)) return {};
  return {
    assistantMessageId:
      typeof value.assistantMessageId === "string"
        ? value.assistantMessageId
        : undefined,
    assistantText:
      typeof value.assistantText === "string" ? value.assistantText : undefined,
    toolCalls: Array.isArray(value.toolCalls)
      ? (value.toolCalls as PersistedToolCall[])
      : undefined,
    toolResults: Array.isArray(value.toolResults)
      ? (value.toolResults as PersistedToolResult[])
      : undefined,
  };
}

function latestActivityLabel(
  events: readonly AgentActivityEvent[],
): string | undefined {
  return events.length > 0 ? events[events.length - 1]?.label : undefined;
}

function toToolCalls(value: unknown): PersistedToolCall[] | null {
  return Array.isArray(value) ? (value as PersistedToolCall[]) : null;
}

function toToolResults(value: unknown): PersistedToolResult[] | null {
  return Array.isArray(value) ? (value as PersistedToolResult[]) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
