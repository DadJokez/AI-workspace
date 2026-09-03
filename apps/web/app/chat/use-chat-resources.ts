import type { ModelOption } from "@/components/ModelSelector";
import type { SlashSkill } from "@/components/ChatInput";
import type { ThreadSummary } from "@/components/Sidebar";
import { fetchJson, throwApiError } from "@/lib/client-api";
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
import { useCallback, useEffect, useRef, useState } from "react";
import posthog from "posthog-js";

export function useChatResources() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string>();
  const modelsRequestIdRef = useRef(0);
  const [defaultModelId, setDefaultModelId] = useState(
    FALLBACK_DEFAULT_MODEL_ID,
  );
  const [runtimeV2Enabled, setRuntimeV2Enabled] = useState(false);
  const [liveTurnSteeringSupported, setLiveTurnSteeringSupported] =
    useState(false);
  const [studioBrowserSupported, setStudioBrowserSupported] = useState(false);
  const [user, setUser] = useState<UserResponse["user"]>();
  const [userLoading, setUserLoading] = useState(true);
  const [userError, setUserError] = useState<string>();
  const userRequestIdRef = useRef(0);
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

  const refreshModels = useCallback(async () => {
    const requestId = ++modelsRequestIdRef.current;
    setModelsLoading(true);
    try {
      const data = await fetchJson<ModelsResponse>(
        "/api/models",
        { cache: "no-store" },
        "Comparative couldn't start.",
      );
      if (!Array.isArray(data.models) || data.models.length === 0) {
        throw new Error("Comparative couldn't start.");
      }
      if (requestId !== modelsRequestIdRef.current) return;
      setModels(data.models);
      setDefaultModelId(data.defaultModelId);
      setRuntimeV2Enabled(data.runtimeV2Enabled === true);
      setLiveTurnSteeringSupported(
        data.runtimeCapabilities?.liveTurnSteering === true,
      );
      setStudioBrowserSupported(
        data.runtimeCapabilities?.studioBrowser === true,
      );
      setModelsError(undefined);
    } catch {
      if (requestId !== modelsRequestIdRef.current) return;
      setModels([]);
      setModelsError("Comparative couldn't start.");
    } finally {
      if (requestId === modelsRequestIdRef.current) {
        setModelsLoading(false);
      }
    }
  }, []);

  const refreshThreads = useCallback(async () => {
    try {
      const data = await fetchJson<ThreadsResponse>(
        `/api/threads?limit=${THREADS_LIMIT}&scope=mine`,
        undefined,
        "Could not load chats.",
      );
      const nextThreads = sortThreadHistory(data.threads);
      setThreads(nextThreads);
      setThreadsError(undefined);
    } catch (error) {
      setThreadsError(error instanceof Error ? error.message : String(error));
    } finally {
      setThreadsLoading(false);
    }
  }, []);

  const refreshUser = useCallback(async () => {
    const requestId = ++userRequestIdRef.current;
    setUserLoading(true);
    setUserError(undefined);
    try {
      const response = await fetch("/api/user");
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok) {
        await throwApiError(response, "Could not load your profile.");
      }
      const data = (await response.json()) as UserResponse;
      if (requestId !== userRequestIdRef.current || !data.user) return;
      setUser(data.user);
      setUserDefaultModelId(data.user.defaultModelId ?? undefined);
      setUserError(undefined);
      posthog.identify(data.user.id, { role: data.user.role });
    } catch (error) {
      if (requestId !== userRequestIdRef.current) return;
      console.error("failed to load /api/user", error);
      setUserError("Could not load your profile.");
    } finally {
      if (requestId === userRequestIdRef.current) {
        setUserLoading(false);
      }
    }
  }, []);

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
    void refreshModels();
    return () => {
      modelsRequestIdRef.current += 1;
    };
  }, [refreshModels]);

  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

  useEffect(() => {
    void refreshUser();
    return () => {
      userRequestIdRef.current += 1;
    };
  }, [refreshUser]);

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
        const body = await fetchJson<{
          suggestions?: unknown;
          connectedProviders?: unknown;
        }>(
          "/api/recommendations/prompts",
          { credentials: "include" },
          "Could not load chat suggestions.",
        );
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
      const body = await fetchJson<UserResponse>(
        "/api/user",
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ defaultModelId: modelId }),
        },
        "Could not save the default model.",
      );
      setUser(body.user);
      setUserDefaultModelId(body.user.defaultModelId ?? modelId);
    } catch (error) {
      console.error("failed to save default model", error);
    }
  }

  return {
    models,
    modelsLoading,
    modelsError,
    defaultModelId,
    runtimeV2Enabled,
    liveTurnSteeringSupported,
    studioBrowserSupported,
    user,
    userLoading,
    userError,
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
    refreshModels,
    refreshUser,
    refreshThreads,
    handleProfileUpdated,
    updateUserDefaultModel,
  };
}
