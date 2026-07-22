import type { ModelOption } from "@/components/ModelSelector";
import type { SlashSkill } from "@/components/ChatInput";
import type { ThreadSummary } from "@/components/Sidebar";
import { FALLBACK_EMPTY_STATE_SUGGESTIONS } from "@/lib/empty-state";
import { sortThreadHistory } from "@/lib/thread-history";
import {
  DEFAULT_MODEL_PREFIX,
  FALLBACK_DEFAULT_MODEL_ID,
  providerBooleanMap,
  stringArray,
  THREADS_LIMIT,
  type ModelsResponse,
  type ThreadsResponse,
  type UserResponse,
} from "./chat-client-state";
import { useEffect, useState } from "react";

export function useChatResources() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModelId, setDefaultModelId] = useState(
    FALLBACK_DEFAULT_MODEL_ID,
  );
  const [runtimeV2Enabled, setRuntimeV2Enabled] = useState(false);
  const [user, setUser] = useState<UserResponse["user"]>();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [threadsError, setThreadsError] = useState<string>();
  const [userDefaultModelId, setUserDefaultModelId] = useState<string>();
  const [oauthConnected, setOauthConnected] = useState<Record<string, boolean>>(
    {},
  );
  const [connectedProviders, setConnectedProviders] = useState<string[] | null>(
    null,
  );
  const [emptyStateSuggestions, setEmptyStateSuggestions] = useState<
    string[] | null
  >(null);
  const [slashSkills, setSlashSkills] = useState<SlashSkill[]>([]);
  const [unreadNotifications, setUnreadNotifications] = useState(0);

  async function refreshThreads() {
    try {
      const response = await fetch(
        `/api/threads?limit=${THREADS_LIMIT}&scope=mine`,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as ThreadsResponse;
      const nextThreads = sortThreadHistory(data.threads);
      setThreads(nextThreads);
      setThreadsError(undefined);
    } catch (error) {
      setThreadsError(error instanceof Error ? error.message : String(error));
    } finally {
      setThreadsLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const response = await fetch("/api/notifications");
        if (!response.ok) return;
        const body = (await response.json()) as { unreadCount?: number };
        if (!cancelled) setUnreadNotifications(body.unreadCount ?? 0);
      } catch {
        // The next tick retries transient failures.
      }
    }
    void poll();
    const intervalId = window.setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/models")
        .then((response) =>
          response.ok ? (response.json() as Promise<ModelsResponse>) : null,
        )
        .catch(() => null),
      fetch(`/api/threads?limit=${THREADS_LIMIT}&scope=mine`)
        .then((response) =>
          response.ok
            ? (response.json() as Promise<ThreadsResponse>)
            : Promise.reject(new Error(`HTTP ${response.status}`)),
        )
        .catch((error) => error as Error),
    ]).then(([modelsData, threadsResult]) => {
      if (cancelled) return;
      if (modelsData) {
        setModels(modelsData.models);
        setDefaultModelId(modelsData.defaultModelId);
        setRuntimeV2Enabled(modelsData.runtimeV2Enabled === true);
      }
      setThreadsLoading(false);
      if (threadsResult instanceof Error) {
        setThreadsError(threadsResult.message);
      } else {
        const nextThreads = sortThreadHistory(threadsResult?.threads ?? []);
        setThreads(nextThreads);
        setThreadsError(undefined);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/user")
      .then(async (response) => {
        if (response.status === 401) {
          window.location.assign("/login");
          return null;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as UserResponse;
      })
      .then((data) => {
        if (cancelled || !data?.user) return;
        setUser(data.user);
        if (data.user.defaultModelId) {
          setUserDefaultModelId(data.user.defaultModelId);
        }
      })
      .catch((error) => {
        if (!cancelled) console.error("failed to load /api/user", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user?.id || typeof window === "undefined" || user.defaultModelId) {
      return;
    }
    try {
      const modelId = localStorage.getItem(`${DEFAULT_MODEL_PREFIX}${user.id}`);
      if (modelId) setUserDefaultModelId(modelId);
    } catch {
      // localStorage is a best-effort migration bridge.
    }
  }, [user?.id, user?.defaultModelId]);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    setEmptyStateSuggestions(null);
    setConnectedProviders(null);

    async function loadEmptyState() {
      try {
        const response = await fetch("/api/recommendations/prompts", {
          credentials: "include",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as {
          suggestions?: unknown;
          connectedProviders?: unknown;
        };
        const suggestions = stringArray(body.suggestions).slice(0, 4);
        const providers = stringArray(body.connectedProviders);
        if (cancelled) return;
        setEmptyStateSuggestions(
          suggestions.length === 4
            ? suggestions
            : [...FALLBACK_EMPTY_STATE_SUGGESTIONS],
        );
        setConnectedProviders(providers);
        setOauthConnected(providerBooleanMap(providers));
      } catch {
        if (cancelled) return;
        setEmptyStateSuggestions([...FALLBACK_EMPTY_STATE_SUGGESTIONS]);
        try {
          const response = await fetch("/api/oauth/status", {
            credentials: "include",
          });
          if (!response.ok) return;
          const body = (await response.json()) as Record<string, unknown>;
          const providers = Object.entries(body)
            .filter(([, connected]) => connected === true)
            .map(([provider]) => provider);
          if (cancelled) return;
          setConnectedProviders(providers);
          setOauthConnected(providerBooleanMap(providers));
        } catch {
          // Keep copy neutral when neither provider source is reachable.
        }
      }
    }

    void loadEmptyState();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/skills")
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { skills?: SlashSkill[] };
        if (!cancelled && Array.isArray(body.skills)) {
          setSlashSkills(body.skills);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function handleProfileUpdated(next: {
    displayName: string;
    customInstructions: string | null;
    defaultModelId?: string | null;
  }) {
    setUser((previous) => (previous ? { ...previous, ...next } : previous));
  }

  async function updateUserDefaultModel(modelId: string) {
    if (!user?.id) return;
    try {
      localStorage.setItem(`${DEFAULT_MODEL_PREFIX}${user.id}`, modelId);
    } catch {
      // Persisting the server preference remains authoritative.
    }
    setUserDefaultModelId(modelId);
    setUser((previous) =>
      previous ? { ...previous, defaultModelId: modelId } : previous,
    );

    try {
      const response = await fetch("/api/user", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultModelId: modelId }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as UserResponse;
      setUser(body.user);
      setUserDefaultModelId(body.user.defaultModelId ?? modelId);
    } catch (error) {
      console.error("failed to save default model", error);
    }
  }

  return {
    models,
    defaultModelId,
    runtimeV2Enabled,
    user,
    setUser,
    threads,
    setThreads,
    threadsLoading,
    threadsError,
    userDefaultModelId,
    oauthConnected,
    connectedProviders,
    emptyStateSuggestions,
    slashSkills,
    unreadNotifications,
    setUnreadNotifications,
    refreshThreads,
    handleProfileUpdated,
    updateUserDefaultModel,
  };
}
