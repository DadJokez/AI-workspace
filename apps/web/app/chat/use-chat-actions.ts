import type { SlashSkill } from "@/components/ChatInput";
import {
  markAppDraftVersionDeployed,
  type AppDraftVersionSummary,
} from "@/lib/app-draft-versions";
import type {
  PersistedRecommendation,
  RecommendationStatus,
} from "@/lib/recommendations";
import { useState, type Dispatch, type SetStateAction } from "react";
import {
  appNameFromRecommendation,
  mergeLoadedMessages,
  threadMessageToUiMessage,
  type ChatTab,
  type ThreadMessagesResponse,
} from "./chat-client-state";
import type { SendChatMessage } from "./use-chat-stream";

interface UseChatActionsOptions {
  activeTab: ChatTab | undefined;
  slashSkills: SlashSkill[];
  send: SendChatMessage;
  patchTab: (id: string, patch: Partial<ChatTab>) => void;
  setTabs: Dispatch<SetStateAction<ChatTab[]>>;
  refreshThreads: () => void | Promise<void>;
}

export function useChatActions({
  activeTab,
  slashSkills,
  send,
  patchTab,
  setTabs,
  refreshThreads,
}: UseChatActionsOptions) {
  const [recommendationPendingId, setRecommendationPendingId] =
    useState<string>();
  const [appDraftPendingId, setAppDraftPendingId] = useState<string>();
  const [runActionPendingId, setRunActionPendingId] = useState<string>();

  function patchRecommendation(
    recommendation: PersistedRecommendation,
    status: RecommendationStatus,
  ) {
    setTabs((previous) =>
      previous.map((tab) => ({
        ...tab,
        messages: tab.messages.map((message) => ({
          ...message,
          recommendations: message.recommendations?.map((candidate) =>
            candidate.dbId === recommendation.dbId
              ? { ...candidate, status }
              : candidate,
          ),
        })),
      })),
    );
  }

  async function handleRecommendationAction(
    recommendation: PersistedRecommendation,
    status: RecommendationStatus,
  ) {
    if (!activeTab) return;
    setRecommendationPendingId(recommendation.dbId);
    patchTab(activeTab.id, { error: undefined });
    try {
      const response = await fetch(
        `/api/recommendations/${recommendation.dbId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        recommendation?: PersistedRecommendation;
        message?: string;
        error?: string;
      };
      if (!response.ok || !body.recommendation) {
        throw new Error(
          body.message ?? body.error ?? "Recommendation update failed",
        );
      }
      patchRecommendation(body.recommendation, status);

      if (status !== "accepted") return;
      if (recommendation.action.kind === "run_skill") {
        const skillId = recommendation.action.skillId;
        const skill = slashSkills.find(
          (candidate) => candidate.id === skillId,
        );
        if (!skill) {
          throw new Error("Could not find that skill in your current catalog.");
        }
        await send(`/${skill.slug}`, undefined, {
          id: skill.id,
          slug: skill.slug,
          name: skill.name,
          source: "explicit",
          args: "",
        });
      } else if (recommendation.action.kind === "open_app") {
        window.location.assign(
          recommendation.action.slug
            ? `/apps/${encodeURIComponent(recommendation.action.slug)}`
            : `/apps/manage/${recommendation.action.appId}`,
        );
      } else if (recommendation.action.kind === "deploy_app") {
        const response = await fetch("/api/apps", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            artifactId: recommendation.action.artifactId,
            name: appNameFromRecommendation(recommendation),
            description: recommendation.reason,
          }),
        });
        const body = (await response.json().catch(() => ({}))) as {
          app?: { id?: string };
          message?: string;
          error?: string;
        };
        if (!response.ok || !body.app?.id) {
          throw new Error(body.message ?? body.error ?? "Could not deploy app.");
        }
        window.location.assign(`/apps/manage/${body.app.id}`);
      } else if (recommendation.action.kind === "create_skill") {
        window.location.assign("/skills/new");
      }
    } catch (error) {
      patchTab(activeTab.id, {
        error:
          error instanceof Error
            ? error.message
            : "Recommendation action failed.",
      });
    } finally {
      setRecommendationPendingId(undefined);
    }
  }

  async function handleAppDraftDeploy(version: AppDraftVersionSummary) {
    if (!activeTab) return;
    setAppDraftPendingId(version.id);
    patchTab(activeTab.id, { error: undefined });
    try {
      const response = await fetch(`/api/apps/${version.appId}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appVersionId: version.id }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        url?: string;
        message?: string;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.message ?? body.error ?? "Could not deploy update.");
      }
      setTabs((previous) =>
        previous.map((tab) => {
          const current = tab.messages.flatMap(
            (message) => message.appDraftVersions ?? [],
          );
          if (!current.some((candidate) => candidate.id === version.id)) {
            return tab;
          }
          const updatedById = new Map(
            markAppDraftVersionDeployed(current, version.id, body.url).map(
              (candidate) => [candidate.id, candidate],
            ),
          );
          return {
            ...tab,
            messages: tab.messages.map((message) => ({
              ...message,
              appDraftVersions: message.appDraftVersions?.map(
                (candidate) => updatedById.get(candidate.id) ?? candidate,
              ),
            })),
          };
        }),
      );
      if (activeTab.threadId) {
        try {
          await refreshActiveThreadMessages(activeTab.id, activeTab.threadId);
        } catch (error) {
          console.error("failed to refresh app publish receipt", error);
        }
      }
    } catch (error) {
      patchTab(activeTab.id, {
        error:
          error instanceof Error ? error.message : "Could not deploy update.",
      });
    } finally {
      setAppDraftPendingId(undefined);
    }
  }

  async function refreshActiveThreadMessages(tabId: string, threadId: string) {
    const response = await fetch(`/api/threads/${threadId}/messages`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as ThreadMessagesResponse;
    const messages = body.messages.map(threadMessageToUiMessage);
    setTabs((previous) =>
      previous.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              messages: mergeLoadedMessages(messages, tab.messages),
              loaded: true,
            }
          : tab,
      ),
    );
  }

  async function runAction(
    runId: string,
    action: "cancel" | "retry" | "resume",
  ) {
    if (!activeTab?.threadId) return;
    setRunActionPendingId(`${action}:${runId}`);
    patchTab(activeTab.id, { error: undefined });
    try {
      const response = await fetch(`/api/runs/${runId}/${action}`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.message ?? body.error ?? `${action} failed`);
      }
      await refreshActiveThreadMessages(activeTab.id, activeTab.threadId);
      void refreshThreads();
    } catch (error) {
      patchTab(activeTab.id, {
        error: error instanceof Error ? error.message : `${action} failed`,
      });
    } finally {
      setRunActionPendingId(undefined);
    }
  }

  return {
    recommendationPendingId,
    appDraftPendingId,
    runActionPendingId,
    handleRecommendationAction,
    handleAppDraftDeploy,
    runAction,
  };
}
