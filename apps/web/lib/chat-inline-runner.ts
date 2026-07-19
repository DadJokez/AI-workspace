import { type ChatThread, type Database } from "@ai-workspace/db";
import { getRuntime, type RuntimeName } from "@ai-workspace/agent-runtime";
import type { ChatContextUploadedFile } from "@/lib/chat-context-pack";
import type { ChatRuntimeRoute } from "@/lib/chat-routing";
import type { PinnedActiveSkill } from "@/lib/pinned-context";
import { enabledModelsForPurpose } from "@/lib/model-registry";
import { resolveRuntimeModelSelection } from "@/lib/runtime-model-policy";
import {
  executeChatTurn,
  type ChatRunTimingMarks,
  type ChatStreamSend,
} from "@/lib/execute-chat-turn";

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
  requestStartedAt?: Date;
  signal?: AbortSignal;
  send: ChatStreamSend;
  diagnosticStreamEnabled?: boolean;
}

/**
 * Interactive-lane shell around the shared turn pipeline (#442): resolves
 * the turn model and runtime, wires the browser request's abort signal, and
 * hands SSE transport + timing to `executeChatTurn`.
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
  } finally {
    signal?.removeEventListener("abort", externalAbort);
  }
}

function resolveRuntimeName(route: ChatRuntimeRoute): RuntimeName {
  if (route.runtimeTarget === "agentcore-worker") return "agentcore";
  const raw = process.env.RUNTIME_V2_DIRECT_RUNTIME?.trim().toLowerCase();
  if (raw === "bedrock") return raw;
  return "bedrock";
}
