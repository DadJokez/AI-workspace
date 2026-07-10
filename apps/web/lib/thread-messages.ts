import {
  chatMessages,
  type Database,
  runs,
  runEvents,
  workspaceArtifacts,
} from "@ai-workspace/db";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { AgentActivityEvent } from "@/lib/activity-events";
import {
  parseAppDraftVersionSummaries,
  type AppDraftVersionSummary,
} from "@/lib/app-draft-versions";
import { runEventsToActivityEvents } from "@/lib/run-events";
import type {
  PersistedToolCall,
  PersistedToolResult,
} from "@/lib/tool-events";
import {
  serializeWorkspaceArtifact,
  type WorkspaceArtifactSummary,
} from "@/lib/workspace-artifacts";
import { loadRecommendationsForMessages } from "@/lib/recommendation-persistence";
import type { PersistedRecommendation } from "@/lib/recommendations";

export interface ChatRunOutput {
  assistantMessageId?: string;
  assistantText?: string;
  toolCalls?: PersistedToolCall[];
  toolResults?: PersistedToolResult[];
  artifacts?: WorkspaceArtifactSummary[];
  appDraftVersions?: AppDraftVersionSummary[];
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
  appDraftVersions?: AppDraftVersionSummary[];
  recommendations?: PersistedRecommendation[];
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
        id: runs.id,
        status: runs.status,
        modelId: runs.modelId,
        runtime: runs.runtime,
        error: runs.error,
        inputs: runs.inputs,
        outputs: runs.outputs,
        startedAt: runs.startedAt,
        createdAt: runs.createdAt,
      })
      .from(runs)
      .where(
        and(
          eq(runs.threadId, threadId),
          or(
            eq(runs.skillSlug, "chat-turn"),
            inArray(runs.triggerType, [
              "skill",
              "scheduled",
              "github_event",
              "skill_retry",
            ]),
          ),
        ),
      )
      .orderBy(asc(runs.createdAt)),
  ]);

  const runIds = runRows.map((run) => run.id);
  const messageIds = messageRows.map((message) => message.id);
  const [eventRows, artifactRows, recommendationsByMessageId] =
    await Promise.all([
      runIds.length > 0
        ? db
            .select({
              id: runEvents.id,
              runId: runEvents.runId,
              sequence: runEvents.sequence,
              provider: runEvents.provider,
              toolName: runEvents.toolName,
              eventType: runEvents.eventType,
              status: runEvents.status,
              label: runEvents.label,
              toolCallId: runEvents.toolCallId,
              input: runEvents.input,
              output: runEvents.output,
              error: runEvents.error,
              metadata: runEvents.metadata,
              occurredAt: runEvents.occurredAt,
            })
            .from(runEvents)
            .where(inArray(runEvents.runId, runIds))
            .orderBy(asc(runEvents.sequence), asc(runEvents.occurredAt))
        : Promise.resolve([]),
      messageIds.length > 0
        ? db
            .select()
            .from(workspaceArtifacts)
            .where(inArray(workspaceArtifacts.chatMessageId, messageIds))
            .orderBy(asc(workspaceArtifacts.createdAt))
        : Promise.resolve([]),
      loadRecommendationsForMessages({ db, messageIds }),
    ]);

  const eventsByRunId = new Map<string, typeof eventRows>();
  for (const event of eventRows) {
    const existing = eventsByRunId.get(event.runId) ?? [];
    existing.push(event);
    eventsByRunId.set(event.runId, existing);
  }

  const activityByAssistantMessageId = new Map<string, AgentActivityEvent[]>();
  const appDraftVersionsByAssistantMessageId = new Map<
    string,
    AppDraftVersionSummary[]
  >();
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
      if (output.appDraftVersions?.length) {
        appDraftVersionsByAssistantMessageId.set(
          output.assistantMessageId,
          output.appDraftVersions,
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
      content: activeRunMessageContent({
        status: run.status,
        error: run.error,
        output,
        hasArtifactContext: hasArtifactContextTarget(run.inputs),
      }),
      modelId: run.modelId,
      runtime: run.runtime,
      toolCalls: output.toolCalls ?? null,
      toolResults: output.toolResults ?? null,
      artifacts: output.artifacts,
      appDraftVersions: output.appDraftVersions,
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
    appDraftVersions: appDraftVersionsByAssistantMessageId.get(message.id),
    activityEvents: activityByAssistantMessageId.get(message.id),
    recommendations: recommendationsByMessageId.get(message.id),
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

export function activeRunMessageContent({
  status,
  error,
  output,
  hasArtifactContext = false,
}: {
  status: string;
  error?: string | null;
  output: ChatRunOutput;
  hasArtifactContext?: boolean;
}): string {
  const fallback = terminalRunMessage(status, error);
  if (
    (status === "failed" || status === "canceled") &&
    output.assistantText &&
    !output.artifacts?.length &&
    hasArtifactLikePartialOutput(output.assistantText, hasArtifactContext)
  ) {
    const artifactMessage = hasArtifactContext
      ? "Artifact update was interrupted before Comparative could save a complete workspace artifact. Retry the run to generate the updated artifact."
      : "Artifact response was interrupted before Comparative could save a complete workspace artifact. Retry the run to generate the artifact.";
    return [
      fallback,
      artifactMessage,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  return output.assistantText ?? fallback;
}

function hasArtifactLikePartialOutput(
  text: string,
  hasArtifactContext: boolean,
): boolean {
  const explicitArtifactFence =
    /```[^\n]*(?:filename=|\b[A-Za-z0-9._/ -]+\.(?:html?|md|markdown|csv|json|txt)\b)/i.test(
      text,
    );
  if (explicitArtifactFence) return true;
  if (!hasArtifactContext) return false;

  return (
    /```[^\n]*\b(?:html|md|markdown|csv|json)\b/i.test(text) ||
    /<!doctype\s+html|<html[\s>]/i.test(text)
  );
}

function hasArtifactContextTarget(inputs: unknown): boolean {
  return isRecord(inputs) && isRecord(inputs.artifactContextTarget);
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
    appDraftVersions: parseAppDraftVersionSummaries(value.appDraftVersions),
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
