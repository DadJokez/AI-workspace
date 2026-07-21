import { type ChatThread, type Database, runs } from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { getRuntime, type RuntimeName } from "@ai-workspace/agent-runtime";
import type { ChatContextUploadedFile } from "@/lib/chat-context-pack";
import type { ChatRuntimeRoute } from "@/lib/chat-routing";
import type { PinnedActiveSkill } from "@/lib/pinned-context";
import { enabledModelsForPurpose } from "@/lib/model-registry";
import { appendRunEventBestEffort } from "@/lib/run-events";
import { resolveRuntimeModelSelection } from "@/lib/runtime-model-policy";
import {
  executeChatTurn,
  type ChatRunTimingMarks,
  type ChatStreamSend,
} from "@/lib/execute-chat-turn";

/** Cadence for the inline lane's liveness heartbeat (#443). */
const INLINE_HEARTBEAT_INTERVAL_MS = 60_000;

export interface StreamInlineChatRunInput {
  db: Database;
  runId: string;
  thread: ChatThread;
  userId: string;
  userMessageId: string;
  prompt: string;
  modelId: string;
  modelOverride?: boolean;
  route: ChatRuntimeRoute;
  activatedSkills?: Array<Record<string, unknown>>;
  activeSkillPrompt?: PinnedActiveSkill;
  requestedProviders?: string[];
  uploadedFiles?: ChatContextUploadedFile[];
  /** Validated browser timezone for this interactive turn (#432). */
  userTimeZone?: string;
  requestStartedAt?: Date;
  signal?: AbortSignal;
  send: ChatStreamSend;
  diagnosticStreamEnabled?: boolean;
}

/**
 * Interactive-lane shell around the shared turn pipeline (#442): resolves
 * the turn model and runtime, wires the browser request's abort signal, and
 * hands SSE transport + timing to `executeChatTurn`.
 *
 * #443 crash discipline: while the turn runs, a heartbeat keeps
 * `lastHeartbeatAt` fresh so the worker's orphan sweep never reaps a live
 * run; if the pipeline throws, the run is marked failed (only while still
 * `running` — never over a terminal state) before the error propagates to
 * the route, so no crash strands a run in `running`.
 */
export async function streamInlineChatRun({
  db,
  runId,
  thread,
  userId,
  userMessageId,
  prompt,
  modelId,
  modelOverride = false,
  route,
  activatedSkills,
  activeSkillPrompt,
  requestedProviders,
  uploadedFiles = [],
  userTimeZone,
  requestStartedAt,
  signal,
  send,
  diagnosticStreamEnabled = false,
}: StreamInlineChatRunInput): Promise<void> {
  const timing: ChatRunTimingMarks = {
    requestStartedAt: requestStartedAt ?? new Date(),
    inlineStartedAt: new Date(),
  };
  const runtimeName = resolveRuntimeName(route);
  // #300: this turn may only use models enabled for its lane's purpose.
  const modelSelection = resolveRuntimeModelSelection({
    requestedModelId: modelId,
    route,
    runtimeName,
    message: prompt,
    forceRequestedModel: modelOverride,
    enabledModelIds: new Set(await enabledModelsForPurpose(db, route.lane)),
  });
  const runtime = getRuntime({ runtime: runtimeName });
  const runtimeAbort = new AbortController();
  const externalAbort = () => runtimeAbort.abort();
  signal?.addEventListener("abort", externalAbort, { once: true });
  const heartbeat = setInterval(() => {
    void heartbeatInlineRun(db, runId).catch((err) => {
      process.stderr.write(
        `[chat-inline-heartbeat-error] ${JSON.stringify({
          runId,
          message: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
    });
  }, INLINE_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  try {
    await executeChatTurn({
      db,
      runId,
      userId,
      thread,
      prompt,
      userMessageId,
      route,
      runtime,
      runtimeAbort,
      modelId: modelSelection.modelId,
      requestedProviders,
      activeSkillPrompt,
      uploadedFiles,
      userTimeZone,
      suppressedSkillIds:
        activatedSkills?.flatMap((skill) =>
          typeof skill.id === "string" ? [skill.id] : [],
        ) ?? [],
      interactive: true,
      lane: {
        kind: "inline",
        send,
        signal,
        diagnosticStreamEnabled,
        timing,
        modelSelection,
        requestedModelId: modelId,
        modelOverride,
        activatedSkills,
      },
    });
  } catch (err) {
    await markInlineRunFailed(db, runId, err);
    throw err;
  } finally {
    clearInterval(heartbeat);
    signal?.removeEventListener("abort", externalAbort);
  }
}

async function heartbeatInlineRun(db: Database, runId: string): Promise<void> {
  const now = new Date();
  await db
    .update(runs)
    .set({ lastHeartbeatAt: now, updatedAt: now })
    .where(and(eq(runs.id, runId), eq(runs.status, "running")));
}

/**
 * Best-effort terminal write for a crashed inline turn. Guarded on
 * `status = 'running'` so a late throw (e.g. a closed SSE controller) can
 * never overwrite a turn that already persisted its real terminal state.
 */
async function markInlineRunFailed(
  db: Database,
  runId: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  try {
    const completedAt = new Date();
    const updated = await db
      .update(runs)
      .set({
        status: "failed",
        error: message,
        completedAt,
        updatedAt: completedAt,
      })
      .where(and(eq(runs.id, runId), eq(runs.status, "running")))
      .returning({ id: runs.id });
    if (updated.length === 0) return;
    await appendRunEventBestEffort("chat-inline-event-error", {
      db,
      runId,
      eventType: "run_failed",
      status: "failed",
      label: "Inline run crashed before finishing",
      error: message,
    });
  } catch (persistErr) {
    process.stderr.write(
      `[chat-inline-crash-persist-error] ${JSON.stringify({
        runId,
        message:
          persistErr instanceof Error ? persistErr.message : String(persistErr),
      })}\n`,
    );
  }
}

function resolveRuntimeName(route: ChatRuntimeRoute): RuntimeName {
  if (route.runtimeTarget === "agentcore-worker") return "agentcore";
  const raw = process.env.RUNTIME_V2_DIRECT_RUNTIME?.trim().toLowerCase();
  if (raw === "bedrock") return raw;
  return "bedrock";
}
