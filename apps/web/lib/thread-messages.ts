import {
  chatMessages,
  type Database,
  recipeRuns,
  runEvents,
  workspaceArtifacts,
} from "@ai-workspace/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { AgentActivityEvent } from "@/lib/activity-events";
import { runEventsToActivityEvents } from "@/lib/run-events";
import type {
  PersistedToolCall,
  PersistedToolResult,
} from "@/lib/tool-events";
import {
  serializeWorkspaceArtifact,
  type WorkspaceArtifactSummary,
} from "@/lib/workspace-artifacts";

interface ChatRunOutput {
  assistantMessageId?: string;
  assistantText?: string;
  toolCalls?: PersistedToolCall[];
  toolResults?: PersistedToolResult[];
  artifacts?: WorkspaceArtifactSummary[];
}

export interface ThreadMessageWithActivity {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  modelId: string | null;
  runtime: string | null;
  toolCalls: PersistedToolCall[] | null;
  toolResults: PersistedToolResult[] | null;
  artifacts?: WorkspaceArtifactSummary[];
  activityEvents?: AgentActivityEvent[];
  pending?: boolean;
  status?: string;
  runId?: string;
  runStatus?: string;
  runError?: string | null;
  canCancel?: boolean;
  canRetry?: boolean;
  canResume?: boolean;
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
        error: recipeRuns.error,
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
  const messageIds = messageRows.map((message) => message.id);
  const eventRows =
    runIds.length > 0
      ? await db
          .select({
            id: runEvents.id,
            recipeRunId: runEvents.recipeRunId,
            sequence: runEvents.sequence,
            eventType: runEvents.eventType,
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
  const artifactRows =
    messageIds.length > 0
      ? await db
          .select()
          .from(workspaceArtifacts)
          .where(inArray(workspaceArtifacts.chatMessageId, messageIds))
          .orderBy(asc(workspaceArtifacts.createdAt))
      : [];

  const eventsByRunId = new Map<string, typeof eventRows>();
  for (const event of eventRows) {
    const existing = eventsByRunId.get(event.recipeRunId) ?? [];
    existing.push(event);
    eventsByRunId.set(event.recipeRunId, existing);
  }

  const activityByAssistantMessageId = new Map<string, AgentActivityEvent[]>();
  const artifactsByMessageId = new Map<string, WorkspaceArtifactSummary[]>();
  const activeRunMessages: ThreadMessageWithActivity[] = [];

  for (const artifact of artifactRows) {
    if (!artifact.chatMessageId) continue;
    const existing = artifactsByMessageId.get(artifact.chatMessageId) ?? [];
    existing.push(serializeWorkspaceArtifact(artifact));
    artifactsByMessageId.set(artifact.chatMessageId, existing);
  }

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
    if (
      run.status !== "queued" &&
      run.status !== "running" &&
      run.status !== "failed" &&
      run.status !== "canceled"
    ) {
      continue;
    }

    activeRunMessages.push({
      id: `run:${run.id}`,
      role: "assistant",
      content:
        output.assistantText ??
        terminalRunMessage(run.status, run.error),
      modelId: run.modelId,
      runtime: run.runtime,
      toolCalls: output.toolCalls ?? null,
      toolResults: output.toolResults ?? null,
      artifacts: output.artifacts,
      activityEvents,
      pending: run.status === "queued" || run.status === "running",
      status:
        latestActivityLabel(activityEvents) ??
        (run.status === "queued"
          ? "Queued..."
          : run.status === "running"
            ? "Working..."
            : undefined),
      runId: run.id,
      runStatus: run.status,
      runError: run.error,
      canCancel: run.status === "queued" || run.status === "running",
      canRetry: run.status === "failed" || run.status === "canceled",
      canResume: run.status === "queued" || run.status === "running",
      createdAt: run.startedAt ?? run.createdAt,
    });
  }

  const messages = messageRows.map((message) => ({
    ...message,
    toolCalls: toToolCalls(message.toolCalls),
    toolResults: toToolResults(message.toolResults),
    artifacts: artifactsByMessageId.get(message.id),
    activityEvents: activityByAssistantMessageId.get(message.id),
  }));

  return [...messages, ...activeRunMessages].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
}

function terminalRunMessage(status: string, error?: string | null): string {
  if (status === "canceled") return "Run canceled before an answer was saved.";
  if (status === "failed") {
    return error
      ? `Run failed before an answer was saved.\n\n${error}`
      : "Run failed before an answer was saved.";
  }
  return "";
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
    artifacts: Array.isArray(value.artifacts)
      ? (value.artifacts as WorkspaceArtifactSummary[])
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
