import posthog from "posthog-js";
import { parseAppDraftVersionSummaries } from "@/lib/app-draft-versions";
import type { ChatAttachment } from "@/lib/attachments";
import { throwApiError } from "@/lib/client-api";
import type { ChatModelOverride } from "@/lib/model-command";
import type { ActivatedSlashSkill } from "@/lib/skill-commands";
import { readChatSseStream } from "@/lib/sse";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";
import type { PersistedRecommendation } from "@/lib/recommendations";
import type { ProposalIterationTarget } from "@/lib/output-proposals";
import {
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import {
  deriveSendTitle,
  formatChatError,
  nextPreviewArtifactAfterPersisted,
  parsePersistedSources,
  parseRuntimeLane,
  reduceAssistantStreamMessage,
  streamToolCallToPersisted,
  streamToolResultToPersisted,
  type ChatTab,
  type RightPane,
  type UiMessage,
} from "./chat-client-state";

export type SendChatMessage = (
  text: string,
  attachments?: ChatAttachment[],
  activatedSkill?: ActivatedSlashSkill,
  modelOverride?: ChatModelOverride,
  replaceMessageId?: string,
  proposalIteration?: {
    target: ProposalIterationTarget;
    feedback: string;
  },
) => Promise<void>;

interface UseChatStreamOptions {
  activeTab: ChatTab | undefined;
  defaultModelId: string;
  patchTab: (id: string, patch: Partial<ChatTab>) => void;
  patchTabMessages: (
    id: string,
    update: (messages: UiMessage[]) => UiMessage[],
  ) => void;
  refreshThreads: () => void | Promise<void>;
  setRightPane: Dispatch<SetStateAction<RightPane | null>>;
  stickToBottomRef: MutableRefObject<boolean>;
}

export function useChatStream({
  activeTab,
  defaultModelId,
  patchTab,
  patchTabMessages,
  refreshThreads,
  setRightPane,
  stickToBottomRef,
}: UseChatStreamOptions): {
  send: SendChatMessage;
  stopStreaming: () => void;
} {
  const streamAbortRef = useRef<AbortController | null>(null);

  async function send(
    text: string,
    attachments?: ChatAttachment[],
    activatedSkill?: ActivatedSlashSkill,
    modelOverride?: ChatModelOverride,
    replaceMessageId?: string,
    proposalIteration?: {
      target: ProposalIterationTarget;
      feedback: string;
    },
  ) {
    if (!activeTab || activeTab.busy) return;
    if (!text.trim() && (!attachments || attachments.length === 0)) return;
    const tabId = activeTab.id;
    const replaceIndex = replaceMessageId
      ? activeTab.messages.findIndex(
          (message) =>
            message.id === replaceMessageId && message.role === "user",
        )
      : -1;
    if (replaceMessageId && replaceIndex === -1) return;
    const originalMessages = activeTab.messages;
    const userMsgId = replaceMessageId ?? crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();
    const turnCreatedAt = new Date().toISOString();
    const modelId = activeTab.modelId ?? defaultModelId;
    const requestedModelId =
      modelOverride?.mode === "model" ? modelOverride.modelId : modelId;

    patchTab(tabId, {
      busy: true,
      error: undefined,
      title:
        activeTab.messages.length === 0
          ? deriveSendTitle(text, activatedSkill)
          : activeTab.title,
    });
    const attachmentNote =
      attachments && attachments.length > 0
        ? `\n\n📎 ${attachments.length} file${attachments.length === 1 ? "" : "s"} attached`
        : "";
    patchTabMessages(tabId, (previous) => {
      const replaced = replaceMessageId
        ? previous.find((message) => message.id === replaceMessageId)
        : undefined;
      const replayedUploadCount =
        replaced?.artifacts?.filter(
          (artifact) => artifact.source === "user-upload",
        ).length ?? 0;
      const replayNote =
        !attachmentNote && replayedUploadCount > 0
          ? `\n\n📎 ${replayedUploadCount} file${replayedUploadCount === 1 ? "" : "s"} attached`
          : "";
      return [
        ...(replaceMessageId ? previous.slice(0, replaceIndex) : previous),
        {
          id: userMsgId,
          role: "user",
          content: `${text}${attachmentNote}${replayNote}`,
          createdAt: turnCreatedAt,
          hasAttachments:
            Boolean(attachments?.length) || Boolean(replaced?.hasAttachments),
          attachmentsReplayable: replaced
            ? replaced.attachmentsReplayable
            : Boolean(attachments?.length),
          attachmentPreviews:
            attachments?.map((attachment) => ({
              name: attachment.name,
              ...(typeof attachment.sizeBytes === "number"
                ? { sizeBytes: attachment.sizeBytes }
                : {}),
            })) ??
            replaced?.attachmentPreviews,
          ...(replaced?.artifacts ? { artifacts: replaced.artifacts } : {}),
          persisted: Boolean(replaceMessageId),
        },
        {
          id: assistantMsgId,
          role: "assistant",
          content: "",
          createdAt: turnCreatedAt,
          pending: true,
          status: activatedSkill
            ? `Activated ${activatedSkill.name}…`
            : "Thinking…",
        },
      ];
    });

    posthog.capture("chat_message_sent", {
      model_id: requestedModelId,
      has_attachments: (attachments?.length ?? 0) > 0,
      is_edit: Boolean(replaceMessageId),
      has_activated_skill: Boolean(activatedSkill),
    });

    stickToBottomRef.current = true;

    const abort = new AbortController();
    streamAbortRef.current = abort;
    let responseAccepted = false;
    try {
      const response = await fetch(
        proposalIteration ? "/api/output-proposals/iterate" : "/api/chat",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abort.signal,
          body: JSON.stringify({
            message: text,
            threadId: activeTab.threadId,
            modelId: requestedModelId,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            ...(modelOverride?.mode === "model"
              ? { modelOverride: true }
              : {}),
            attachmentCount: attachments?.length ?? 0,
            ...(activatedSkill ? { activatedSkills: [activatedSkill] } : {}),
            ...(attachments && attachments.length > 0 ? { attachments } : {}),
            ...(replaceMessageId ? { replaceMessageId } : {}),
            ...(proposalIteration ? { proposalIteration } : {}),
          }),
        },
      );
      if (!response.ok) {
        await throwApiError(response, "Could not send the message.");
      }
      responseAccepted = true;

      let assistantModel: string | undefined;
      let assistantLane: ChatTab["messages"][number]["runtimeLane"];
      let queuedRun = false;
      let queuedRunMessageId: string | undefined;
      let streamRunId: string | undefined;
      let streamErrorMessage: string | undefined;
      let assistantDraftId = assistantMsgId;
      const isDraftMessage = (message: UiMessage) =>
        message.id === assistantMsgId || message.id === assistantDraftId;
      const patchDraft = (
        update: Parameters<typeof reduceAssistantStreamMessage>[1],
      ) => {
        patchTabMessages(tabId, (previous) =>
          previous.map((message) =>
            isDraftMessage(message)
              ? reduceAssistantStreamMessage(message, update)
              : message,
          ),
        );
      };

      for await (const event of readChatSseStream(response)) {
        if (event.type === "meta") {
          if (typeof event.threadId === "string") {
            patchTab(tabId, { threadId: event.threadId });
          }
          if (typeof event.userMessageId === "string") {
            patchTabMessages(tabId, (previous) =>
              previous.map((message) =>
                message.id === userMsgId
                  ? {
                      ...message,
                      id: event.userMessageId as string,
                      persisted: true,
                    }
                  : message,
              ),
            );
          }
          if (typeof event.modelId === "string") {
            assistantModel = event.modelId;
          }
          const route = event.runtimeRoute as
            | { useWorker?: unknown; lane?: unknown }
            | undefined;
          assistantLane = parseRuntimeLane(route?.lane);
          if (typeof event.runId === "string") {
            streamRunId = event.runId;
            patchDraft({
              type: "runtime",
              modelId: assistantModel,
              runtimeLane: assistantLane,
              runId: streamRunId,
            });
          }
          if (streamRunId && route?.useWorker === true) {
            const runMessageId = `run:${streamRunId}`;
            queuedRunMessageId = runMessageId;
            assistantDraftId = runMessageId;
            patchTabMessages(tabId, (previous) =>
              previous.map((message) =>
                message.id === assistantMsgId
                  ? {
                      ...message,
                      id: runMessageId,
                      modelId: assistantModel,
                      runtimeLane: assistantLane,
                      runId: streamRunId,
                    }
                  : message,
              ),
            );
          }
        } else if (
          event.type === "model" &&
          typeof event.modelId === "string"
        ) {
          assistantModel = event.modelId;
          patchDraft({
            type: "runtime",
            modelId: assistantModel,
            runtimeLane: assistantLane,
            runId: streamRunId,
          });
        } else if (
          event.type === "text-delta" &&
          typeof event.delta === "string"
        ) {
          patchDraft({ type: "text-delta", delta: event.delta });
        } else if (
          event.type === "usage" &&
          typeof event.tokensIn === "number" &&
          typeof event.tokensOut === "number"
        ) {
          patchDraft({
            type: "usage",
            tokensIn: event.tokensIn,
            tokensOut: event.tokensOut,
          });
        } else if (
          event.type === "metrics" &&
          event.stage === "provider_started"
        ) {
          patchDraft({ type: "provider-started" });
        } else if (
          event.type === "provider-reasoning-delta" &&
          typeof event.iteration === "number" &&
          typeof event.blockIndex === "number" &&
          typeof event.delta === "string"
        ) {
          patchDraft({
            type: "reasoning-delta",
            iteration: event.iteration,
            blockIndex: event.blockIndex,
            delta: event.delta,
          });
        } else if (
          event.type === "provider-reasoning-redacted" &&
          typeof event.iteration === "number" &&
          typeof event.blockIndex === "number"
        ) {
          patchDraft({
            type: "reasoning-redacted",
            iteration: event.iteration,
            blockIndex: event.blockIndex,
          });
        } else if (event.type === "tool-call") {
          patchDraft({
            type: "tool-call",
            call: streamToolCallToPersisted(event.call),
          });
        } else if (event.type === "tool-result") {
          patchTabMessages(tabId, (previous) =>
            previous.map((message) => {
              if (!isDraftMessage(message)) return message;
              const result = streamToolResultToPersisted(
                event.result,
                message.toolCalls ?? [],
              );
              return reduceAssistantStreamMessage(message, {
                type: "tool-result",
                result,
              });
            }),
          );
        } else if (event.type === "queued") {
          queuedRun = true;
          const status =
            typeof event.status === "string"
              ? event.status
              : "Queued for background worker";
          patchTabMessages(tabId, (previous) =>
            previous.map((message) =>
              message.id === assistantMsgId ||
              (typeof event.runId === "string" &&
                message.id === `run:${event.runId}`)
                ? reduceAssistantStreamMessage(message, {
                    type: "queued",
                    status,
                    modelId: assistantModel,
                    runtimeLane: assistantLane,
                    runId:
                      typeof event.runId === "string"
                        ? event.runId
                        : undefined,
                  })
                : message,
            ),
          );
        } else if (
          event.type === "error" &&
          typeof event.message === "string"
        ) {
          streamErrorMessage = event.message;
        } else if (event.type === "failed") {
          throw new Error(event.message || streamErrorMessage);
        } else if (event.type === "done" && streamErrorMessage) {
          throw new Error(streamErrorMessage);
        } else if (event.type === "persisted") {
          const persistedAssistantMessageId =
            typeof event.assistantMessageId === "string"
              ? event.assistantMessageId
              : undefined;
          const artifacts = Array.isArray(event.artifacts)
            ? (event.artifacts as WorkspaceArtifactSummary[])
            : undefined;
          const appDraftVersions = parseAppDraftVersionSummaries(
            event.appDraftVersions,
          );
          const recommendations = Array.isArray(event.recommendations)
            ? (event.recommendations as PersistedRecommendation[])
            : undefined;
          const sources = parsePersistedSources(event.sources);
          const tokensIn =
            typeof event.tokensIn === "number" ? event.tokensIn : undefined;
          const tokensOut =
            typeof event.tokensOut === "number" ? event.tokensOut : undefined;
          patchDraft({
            type: "persisted",
            messageId: persistedAssistantMessageId,
            modelId: assistantModel,
            runtimeLane: assistantLane,
            artifacts,
            appDraftVersions,
            recommendations,
            sources,
            tokensIn,
            tokensOut,
            runId: streamRunId,
          });
          setRightPane((current) => {
            if (current?.kind !== "artifact") return current;
            const nextArtifact = nextPreviewArtifactAfterPersisted(
              current.artifact,
              artifacts,
            );
            return nextArtifact
              ? { kind: "artifact", artifact: nextArtifact }
              : null;
          });
          if (persistedAssistantMessageId) {
            assistantDraftId = persistedAssistantMessageId;
          }
        }
      }

      patchTabMessages(tabId, (previous) =>
        previous.map((message) =>
          isDraftMessage(message) ||
          (queuedRunMessageId !== undefined &&
            message.id === queuedRunMessageId)
            ? reduceAssistantStreamMessage(message, {
                type: "complete",
                queued: queuedRun,
                runId: streamRunId,
              })
            : message,
        ),
      );

      void refreshThreads();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        patchTabMessages(tabId, (previous) =>
          previous.map((message) =>
            message.id === assistantMsgId
              ? reduceAssistantStreamMessage(message, { type: "abort" })
              : message,
          ),
        );
        return;
      }
      patchTab(tabId, { error: formatChatError(error) });
      if ((replaceMessageId || proposalIteration) && !responseAccepted) {
        patchTabMessages(tabId, () => originalMessages);
        return;
      }
      patchTabMessages(tabId, (previous) =>
        previous.map((message) =>
          message.id === assistantMsgId
            ? reduceAssistantStreamMessage(message, { type: "error" })
            : message,
        ),
      );
    } finally {
      if (streamAbortRef.current === abort) streamAbortRef.current = null;
      patchTab(tabId, { busy: false });
      patchTabMessages(tabId, (previous) =>
        previous.filter(
          (message) =>
            !(
              message.id === assistantMsgId &&
              message.pending &&
              message.content.length === 0
            ),
        ),
      );
    }
  }

  function stopStreaming() {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
  }

  return { send, stopStreaming };
}
