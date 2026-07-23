import {
  apps,
  appVersions,
  chatMessages,
  type Database,
  runs,
  runEvents,
  workspaceArtifacts,
} from "@ai-workspace/db";
import {
  parseAssistantSources,
  type AssistantSource,
} from "@ai-workspace/agent";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { AgentActivityEvent } from "@/lib/activity-events";
import {
  isAppDraftVersionStatus,
  parseAppDraftVersionSummaries,
  type AppDraftVersionSummary,
} from "@/lib/app-draft-versions";
import {
  derivePhaseFromRunEvents,
  runEventsToActivityEvents,
} from "@/lib/run-events";
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
import type { ChatRuntimeLane } from "@/lib/chat-routing";
import { liveTokenTotalFromRunOutput } from "@/lib/run-poll";

export interface ChatRunOutput {
  assistantMessageId?: string;
  assistantText?: string;
  toolCalls?: PersistedToolCall[];
  toolResults?: PersistedToolResult[];
  artifacts?: WorkspaceArtifactSummary[];
  appDraftVersions?: AppDraftVersionSummary[];
  sources?: AssistantSource[];
  /** Aggregate only, derived from the persisted usage object. */
  liveTokens?: number;
}

export interface ThreadMessageWithActivity {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  modelId: string | null;
  runtime: string | null;
  runtimeLane?: ChatRuntimeLane;
  toolCalls: PersistedToolCall[] | null;
  toolResults: PersistedToolResult[] | null;
  /** Persisted per-turn usage for the cost meter (#330); null pre-#330 rows. */
  tokensIn?: number | null;
  tokensOut?: number | null;
  artifacts?: WorkspaceArtifactSummary[];
  appDraftVersions?: AppDraftVersionSummary[];
  recommendations?: PersistedRecommendation[];
  sources?: AssistantSource[];
  activityEvents?: AgentActivityEvent[];
  pending?: boolean;
  status?: string;
  /** #359: deterministic phase for in-flight runs, derived server-side. */
  runPhase?: string;
  /** #359: refresh-safe aggregate for the in-flight worker footer. */
  liveTokens?: number;
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
        tokensIn: chatMessages.tokensIn,
        tokensOut: chatMessages.tokensOut,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId))
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id)),
    db
      .select({
        id: runs.id,
        skillSlug: runs.skillSlug,
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
  const laneByAssistantMessageId = new Map<string, ChatRuntimeLane>();
  const sourcesByAssistantMessageId = new Map<string, AssistantSource[]>();
  const appDraftVersionsByAssistantMessageId = new Map<
    string,
    AppDraftVersionSummary[]
  >();
  const artifactsByMessageId = new Map<string, WorkspaceArtifactSummary[]>();
  const activeRunMessages: ThreadMessageWithActivity[] = [];
  const visibleMessageIds = new Set(messageIds);
  const visibleChatRunIds = latestVisibleChatRunIds(runRows, visibleMessageIds);

  for (const artifact of artifactRows) {
    if (!artifact.chatMessageId) continue;
    const existing = artifactsByMessageId.get(artifact.chatMessageId) ?? [];
    existing.push(serializeWorkspaceArtifact(artifact));
    artifactsByMessageId.set(artifact.chatMessageId, existing);
  }

  for (const run of runRows) {
    if (run.skillSlug === "chat-turn") {
      const sourceMessageId = chatRunSourceMessageId(run.inputs);
      if (
        sourceMessageId &&
        !visibleChatRunIds.has(run.id)
      ) {
        continue;
      }
    }
    const output = parseChatRunOutput(run.outputs);
    const runtimeLane = chatRunLane(run.inputs);
    const activityEvents = runEventsToActivityEvents(
      eventsByRunId.get(run.id) ?? [],
    );
    if (output.assistantMessageId) {
      if (runtimeLane) {
        laneByAssistantMessageId.set(output.assistantMessageId, runtimeLane);
      }
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
      if (output.sources?.length) {
        sourcesByAssistantMessageId.set(
          output.assistantMessageId,
          output.sources,
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
      ...(runtimeLane ? { runtimeLane } : {}),
      toolCalls: output.toolCalls ?? null,
      toolResults: output.toolResults ?? null,
      artifacts: output.artifacts,
      appDraftVersions: output.appDraftVersions,
      sources: output.sources,
      activityEvents,
      pending: run.status === "queued" || run.status === "running",
      // #359: reload reconstructs the live footer's phase from persisted
      // events, so refresh mid-run shows the same state as the stream did.
      ...(run.status === "queued" || run.status === "running"
        ? {
            runPhase: derivePhaseFromRunEvents(eventsByRunId.get(run.id) ?? []),
            ...(output.liveTokens !== undefined
              ? { liveTokens: output.liveTokens }
              : {}),
          }
        : {}),
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

  // Reconcile rehydrated draft summaries against the CURRENT app-version
  // truth (#344). Run outputs are frozen at mint time, so after a deploy a
  // reloaded thread would otherwise resurrect the deployed version as an
  // actionable draft. Read-time reconciliation; runs.outputs are never
  // rewritten. The IN-list is scoped to versions already visible in this
  // thread's runs — do not widen it (per-user scoping).
  const draftSummaryIds = new Set<string>();
  for (const summaries of appDraftVersionsByAssistantMessageId.values()) {
    for (const summary of summaries) draftSummaryIds.add(summary.id);
  }
  for (const message of activeRunMessages) {
    for (const summary of message.appDraftVersions ?? []) {
      draftSummaryIds.add(summary.id);
    }
  }
  if (draftSummaryIds.size > 0) {
    const truthRows = await db
      .select({
        id: appVersions.id,
        status: appVersions.status,
        liveVersionId: apps.liveVersionId,
        archivedAt: apps.archivedAt,
      })
      .from(appVersions)
      .innerJoin(apps, eq(appVersions.appId, apps.id))
      .where(inArray(appVersions.id, [...draftSummaryIds]));
    const truthById = new Map<string, AppVersionTruthRow>(
      truthRows.map((row) => [
        row.id,
        {
          id: row.id,
          liveVersionId: row.liveVersionId,
          archived: row.archivedAt !== null,
          // Unknown statuses fail safe to "reverted" (non-actionable).
          status: isAppDraftVersionStatus(row.status)
            ? row.status
            : "reverted",
        },
      ]),
    );
    for (const [messageId, summaries] of appDraftVersionsByAssistantMessageId) {
      appDraftVersionsByAssistantMessageId.set(
        messageId,
        reconcileAppDraftVersionSummaries(summaries, truthById),
      );
    }
    for (const message of activeRunMessages) {
      if (message.appDraftVersions?.length) {
        message.appDraftVersions = reconcileAppDraftVersionSummaries(
          message.appDraftVersions,
          truthById,
        );
      }
    }
  }

  const messages = messageRows.map((message) => ({
    ...message,
    runtimeLane: laneByAssistantMessageId.get(message.id),
    toolCalls: toToolCalls(message.toolCalls),
    toolResults: toToolResults(message.toolResults),
    artifacts: artifactsByMessageId.get(message.id),
    appDraftVersions: appDraftVersionsByAssistantMessageId.get(message.id),
    activityEvents: activityByAssistantMessageId.get(message.id),
    sources: sourcesByAssistantMessageId.get(message.id),
    recommendations: recommendationsByMessageId.get(message.id),
  }));

  return [...messages, ...activeRunMessages].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
}

export interface AppVersionTruthRow {
  id: string;
  status: AppDraftVersionSummary["status"];
  liveVersionId: string | null;
  /** Archived apps keep their history visible but never a deploy affordance. */
  archived: boolean;
}

/**
 * Rewrites rehydrated draft summaries with current version truth (#344).
 * Missing rows mean the draft was hard-deleted — the summary is dropped so a
 * dead card can't render (and the next-highest version's card resurfaces via
 * latestAppDraftVersionIds, which is correct). canDeploy narrows only: a
 * summary minted non-deployable can never become deployable here, and
 * anything not currently a plain draft (deployed, reverted, or the live
 * version) is non-actionable.
 */
export function reconcileAppDraftVersionSummaries(
  summaries: readonly AppDraftVersionSummary[],
  truthById: ReadonlyMap<string, AppVersionTruthRow>,
): AppDraftVersionSummary[] {
  return summaries.flatMap((summary) => {
    const truth = truthById.get(summary.id);
    if (!truth) return [];
    return [
      {
        ...summary,
        status: truth.status,
        canDeploy:
          summary.canDeploy &&
          !truth.archived &&
          truth.status === "draft" &&
          truth.id !== truth.liveVersionId,
      },
    ];
  });
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

export function chatRunLane(inputs: unknown): ChatRuntimeLane | undefined {
  if (!isRecord(inputs) || !isRecord(inputs.runtimeRoute)) return undefined;
  const lane = inputs.runtimeRoute.lane;
  return lane === "fast-local" ||
    lane === "tool-local" ||
    lane === "durable-local"
    ? lane
    : undefined;
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
    sources: parseAssistantSources(value.sources),
    liveTokens: liveTokenTotalFromRunOutput(value) ?? undefined,
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

export function chatRunSourceMessageId(inputs: unknown): string | null {
  if (!isRecord(inputs) || typeof inputs.userMessageId !== "string") {
    return null;
  }
  return inputs.userMessageId;
}

export function latestVisibleChatRunIds(
  runs: readonly { id: string; skillSlug: string | null; inputs: unknown }[],
  visibleMessageIds: ReadonlySet<string>,
): Set<string> {
  const latestByMessageId = new Map<string, string>();
  for (const run of runs) {
    if (run.skillSlug !== "chat-turn") continue;
    const sourceMessageId = chatRunSourceMessageId(run.inputs);
    if (sourceMessageId && visibleMessageIds.has(sourceMessageId)) {
      latestByMessageId.set(sourceMessageId, run.id);
    }
  }
  return new Set(latestByMessageId.values());
}
