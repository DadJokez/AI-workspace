"use client";

import { ArtifactPreviewPane } from "@/components/ArtifactPreviewPane";
import { RunInspectorPane } from "@/components/RunInspectorPane";
import { SlideOverPane } from "@/components/SlideOverPane";
import {
  ChatInput,
  type ChatEditRequest,
  type SlashSkill,
} from "@/components/ChatInput";
import {
  stripAttachmentNoteFromMessage,
  type ChatAttachment,
} from "@/lib/attachments";
import { areUploadsReplayable } from "@/lib/attachment-replay";
import {
  latestAppDraftVersionIds,
  markAppDraftVersionDeployed,
  parseAppDraftVersionSummaries,
  type AppDraftVersionSummary,
} from "@/lib/app-draft-versions";
import { COMPARATIVE_VERSION_LABEL } from "@/lib/product-version";
import type { ActivatedSlashSkill } from "@/lib/skill-commands";
import {
  FeedbackReporter,
  type FeedbackContext,
} from "@/components/FeedbackReporter";
import { MessageBubble } from "@/components/MessageBubble";
import { ThinkingOrb } from "@/components/ThinkingOrb";
import { ModelSelector, type ModelOption } from "@/components/ModelSelector";
import {
  useCommandPalette,
  useRegisterCommandPaletteActions,
} from "@/components/CommandPalette";
import {
  SettingsModal,
  type SettingsSection,
} from "@/components/SettingsModal";
import { WelcomeWizard } from "@/components/WelcomeWizard";
import { shouldShowTour } from "@/lib/tour";
import { NotificationsPanel } from "@/components/NotificationsPanel";
import { Sidebar, type ThreadSummary } from "@/components/Sidebar";
import { ThemeToggle } from "@/components/ThemeToggle";
import { WorkspacePanel } from "@/components/WorkspacePanel";
import {
  buildChatTranscriptMarkdown,
  chatTranscriptFilename,
} from "@/lib/chat-export";
import type { ChatModelOverride } from "@/lib/model-command";
import type { ChatRuntimeLane } from "@/lib/chat-routing";
import { readSseStream } from "@/lib/sse";
import {
  shouldReloadThread,
  type RunStatusResponse,
  type RunStatusSnapshot,
} from "@/lib/run-poll";
import type { AgentActivityEvent } from "@/lib/activity-events";
import type { LiveReasoningBlock } from "@/lib/run-inspector";
import {
  parseToolName,
  type PersistedToolCall,
  type PersistedToolResult,
} from "@/lib/tool-events";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";
import type {
  PersistedRecommendation,
  RecommendationStatus,
} from "@/lib/recommendations";
import { signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

// Model ids come from the AWS-backed model registry exposed by /api/models.
const FALLBACK_DEFAULT_MODEL_ID = "sonnet-4-6";

type RightPane =
  | { kind: "workspace" }
  | { kind: "notifications" }
  | { kind: "artifact"; artifact: WorkspaceArtifactSummary }
  | { kind: "inspector"; runId: string };

const DEFAULT_MODEL_PREFIX = "ai-workspace-default-model:";

interface UiMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt?: string;
  modelId?: string;
  runtimeLane?: ChatRuntimeLane;
  tokensIn?: number | null;
  tokensOut?: number | null;
  pending?: boolean;
  /** Live activity label shown while pending and no text has streamed yet
   *  (e.g. "Thinking…", "Calling github_list_repos…"). */
  status?: string;
  /** #359 live footer: deterministic phase + running token total. */
  livePhase?: string;
  liveTokens?: number;
  toolCalls?: PersistedToolCall[];
  toolResults?: PersistedToolResult[];
  artifacts?: WorkspaceArtifactSummary[];
  appDraftVersions?: AppDraftVersionSummary[];
  recommendations?: PersistedRecommendation[];
  activityEvents?: AgentActivityEvent[];
  runId?: string;
  runStatus?: string;
  runError?: string | null;
  canCancel?: boolean;
  canRetry?: boolean;
  canResume?: boolean;
  hasAttachments?: boolean;
  /**
   * True when every user-upload on this turn can be replayed from storage
   * (#348) — the client-side gate for showing the edit control on file
   * turns. The server-side reconstruction remains the authority.
   */
  attachmentsReplayable?: boolean;
  persisted?: boolean;
  providerReasoning?: LiveReasoningBlock[];
}

export function mergeLoadedMessages(
  loadedMessages: UiMessage[],
  currentMessages: UiMessage[],
): UiMessage[] {
  if (currentMessages.length === 0) return loadedMessages;

  const loadedIds = new Set(loadedMessages.map((m) => m.id));
  const hasSameMessage = (candidate: UiMessage) =>
    loadedMessages.some(
      (m) =>
        m.role === candidate.role &&
        m.content.trim() === candidate.content.trim(),
    );

  const localOnly = currentMessages.filter((m) => {
    if (loadedIds.has(m.id)) return false;
    if (hasSameMessage(m)) return false;
    return true;
  });

  return [...loadedMessages, ...localOnly];
}

export function nextPreviewArtifactAfterPersisted(
  current: WorkspaceArtifactSummary | null,
  persistedArtifacts?: WorkspaceArtifactSummary[],
): WorkspaceArtifactSummary | null {
  if (!current || !persistedArtifacts?.length) return current;

  const nextVersion = persistedArtifacts
    .filter(
      (artifact) =>
        artifact.id !== current.id &&
        artifact.artifactGroupId === current.artifactGroupId,
    )
    .sort((a, b) => b.versionNumber - a.versionNumber)[0];

  return nextVersion ?? current;
}

interface ChatTab {
  id: string;
  title: string;
  threadId?: string;
  messages: UiMessage[];
  modelId?: string;
  busy: boolean;
  error?: string;
  /** True once messages have been loaded, or for a fresh empty chat. */
  loaded: boolean;
}

interface ChatStreamEvent {
  type:
    | "meta"
    | "model"
    | "text-delta"
    | "provider-reasoning-delta"
    | "provider-reasoning-redacted"
    | "provider-response-metadata"
    | "tool-call"
    | "tool-result"
    | "usage"
    | "heartbeat"
    | "metrics"
    | "queued"
    | "error"
    | "done"
    | "persisted";
  [k: string]: unknown;
}

interface ModelsResponse {
  defaultModelId: string;
  models: ModelOption[];
  runtimeV2Enabled?: boolean;
}

interface UserResponse {
  user: {
    id: string;
    email: string;
    displayName: string;
    role: "admin" | "user";
    customInstructions: string | null;
    defaultModelId: string | null;
    assistantName: string | null;
    tourCompletedAt: string | null;
  };
}

interface ThreadsResponse {
  threads: ThreadSummary[];
}

interface ThreadMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  modelId: string | null;
  runtimeLane?: ChatRuntimeLane;
  runtime: "bedrock" | "agentcore" | string | null;
  toolCalls: PersistedToolCall[] | null;
  toolResults: PersistedToolResult[] | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  artifacts?: WorkspaceArtifactSummary[];
  appDraftVersions?: AppDraftVersionSummary[];
  recommendations?: PersistedRecommendation[];
  activityEvents?: AgentActivityEvent[];
  pending?: boolean;
  status?: string;
  runPhase?: string;
  runId?: string;
  runStatus?: string;
  runError?: string | null;
  canCancel?: boolean;
  canRetry?: boolean;
  canResume?: boolean;
  createdAt: string;
}

interface ThreadMessagesResponse {
  messages: ThreadMessage[];
}

function threadMessageToUiMessage(message: ThreadMessage): UiMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    modelId: message.modelId ?? undefined,
    runtimeLane: message.runtimeLane,
    tokensIn: message.tokensIn,
    tokensOut: message.tokensOut,
    pending: message.pending,
    status: message.status,
    livePhase: message.runPhase,
    toolCalls: message.toolCalls ?? undefined,
    toolResults: message.toolResults ?? undefined,
    artifacts: message.artifacts,
    appDraftVersions: message.appDraftVersions,
    recommendations: message.recommendations,
    activityEvents: message.activityEvents,
    runId: message.runId,
    runStatus: message.runStatus,
    runError: message.runError,
    canCancel: message.canCancel,
    canRetry: message.canRetry,
    canResume: message.canResume,
    hasAttachments: message.artifacts?.some(
      (artifact) => artifact.source === "user-upload",
    ),
    attachmentsReplayable: messageUploadsReplayable(message.artifacts),
    persisted: true,
  };
}

function messageUploadsReplayable(
  artifacts: WorkspaceArtifactSummary[] | undefined,
): boolean {
  const uploads = (artifacts ?? []).filter(
    (artifact) => artifact.source === "user-upload",
  );
  return areUploadsReplayable(
    uploads.map((artifact) => ({
      mimeType: artifact.mimeType,
      metadata: artifact.metadata ?? null,
    })),
  );
}

const THREADS_LIMIT = 50;
const RUN_POLL_INTERVAL_MS = 500;
const BACKGROUND_COMPLETION_TITLE = "✓ Done — Comparative";

function makeFreshTab(modelId?: string): ChatTab {
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    threadId: undefined,
    messages: [],
    modelId,
    busy: false,
    loaded: true,
  };
}

function deriveTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 32) return trimmed;
  return trimmed.slice(0, 32).trimEnd() + "…";
}

function deriveSendTitle(
  text: string,
  activatedSkill?: ActivatedSlashSkill,
): string {
  if (!activatedSkill) return deriveTitle(text);
  const args = activatedSkill.args.trim();
  return deriveTitle(
    args ? `${activatedSkill.name}: ${args}` : activatedSkill.name,
  );
}

function appNameFromRecommendation(recommendation: PersistedRecommendation): string {
  const filename =
    typeof recommendation.metadata?.filename === "string"
      ? recommendation.metadata.filename
      : "Generated app";
  const stem = filename.replace(/\.[^.]+$/, "");
  const title = stem
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return title || "Generated app";
}

/** Render an MCP tool name as a compact label for status text.
 *  Examples: "github_list_repos" → "github_list_repos",
 *  "mcp__github__list_repos" → "github · list_repos". Truncates very long
 *  names so the indicator stays one line. */
function formatToolName(raw: string): string {
  const m = /^mcp__([^_]+)__(.+)$/.exec(raw);
  const pretty = m ? `${m[1]} · ${m[2]}` : raw;
  return pretty.length > 48 ? pretty.slice(0, 47) + "…" : pretty;
}

function downloadTextFile({
  filename,
  content,
  mimeType,
}: {
  filename: string;
  content: string;
  mimeType: string;
}) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function streamToolCallToPersisted(value: unknown): PersistedToolCall | null {
  if (!isPlainRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : crypto.randomUUID();
  const name = typeof value.name === "string" ? value.name : "tool";
  const parsed = parseToolName(name);
  return {
    id,
    name,
    provider: parsed.provider,
    toolName: parsed.toolName,
    input: isPlainRecord(value.input) ? value.input : {},
    startedAt: new Date().toISOString(),
  };
}

function streamToolResultToPersisted(
  value: unknown,
  calls: readonly PersistedToolCall[],
): PersistedToolResult | null {
  if (!isPlainRecord(value) || typeof value.toolCallId !== "string") {
    return null;
  }
  const call = calls.find((candidate) => candidate.id === value.toolCallId);
  return {
    toolCallId: value.toolCallId,
    ...(call
      ? {
          name: call.name,
          provider: call.provider,
          toolName: call.toolName,
        }
      : {}),
    output: value.output,
    isError: value.isError === true,
    completedAt: new Date().toISOString(),
  };
}

function upsertToolCall(
  calls: PersistedToolCall[] | undefined,
  call: PersistedToolCall,
): PersistedToolCall[] {
  const existing = calls ?? [];
  if (existing.some((candidate) => candidate.id === call.id)) {
    return existing.map((candidate) =>
      candidate.id === call.id ? { ...candidate, ...call } : candidate,
    );
  }
  return [...existing, call];
}

function upsertToolResult(
  results: PersistedToolResult[] | undefined,
  result: PersistedToolResult,
): PersistedToolResult[] {
  const existing = results ?? [];
  if (existing.some((candidate) => candidate.toolCallId === result.toolCallId)) {
    return existing.map((candidate) =>
      candidate.toolCallId === result.toolCallId
        ? { ...candidate, ...result }
        : candidate,
    );
  }
  return [...existing, result];
}

function updateLiveReasoning(
  blocks: LiveReasoningBlock[] | undefined,
  event: {
    iteration: number;
    blockIndex: number;
    delta?: string;
    redacted?: boolean;
  },
): LiveReasoningBlock[] {
  const existing = blocks ?? [];
  const index = existing.findIndex(
    (block) =>
      block.iteration === event.iteration &&
      block.blockIndex === event.blockIndex,
  );
  const current =
    index >= 0
      ? existing[index]!
      : {
          iteration: event.iteration,
          blockIndex: event.blockIndex,
          text: "",
          redacted: false,
        };
  const next = {
    ...current,
    text: current.text + (event.delta ?? ""),
    redacted: current.redacted || event.redacted === true,
  };
  if (index < 0) return [...existing, next];
  return existing.map((block, blockIndex) =>
    blockIndex === index ? next : block,
  );
}

function formatChatError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/network|failed to fetch|load failed|terminated|aborted/i.test(message)) {
    return "Connection lost while receiving updates. The run may have stopped or the browser stream may have dropped; retry to continue.";
  }
  return message;
}

function parseRuntimeLane(value: unknown): ChatRuntimeLane | undefined {
  return value === "fast-local" ||
    value === "tool-local" ||
    value === "durable-local"
    ? value
    : undefined;
}

function runtimeLaneLabel(lane: ChatRuntimeLane | undefined): string | null {
  if (lane === "fast-local") return "Fast";
  if (lane === "tool-local") return "Tools";
  if (lane === "durable-local") return "Durable";
  return null;
}

function compactModelName(name: string | undefined): string | undefined {
  return name
    ?.replace(/^(Anthropic\s+)?Claude\s+/i, "")
    .replace(/^Amazon\s+/i, "");
}

const STICK_BOTTOM_THRESHOLD = 100;

interface ChatClientProps {
  initialThreadId?: string;
  initialOpen?: "settings" | "artifacts";
}

export function ChatClient({ initialThreadId, initialOpen }: ChatClientProps) {
  const router = useRouter();
  const { openPalette } = useCommandPalette();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModelId, setDefaultModelId] =
    useState<string>(FALLBACK_DEFAULT_MODEL_ID);
  const [runtimeV2Enabled, setRuntimeV2Enabled] = useState(false);
  const [messageClock, setMessageClock] = useState(() => Date.now());
  const [tabs, setTabs] = useState<ChatTab[]>(() => [makeFreshTab()]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0]!.id);
  const [user, setUser] = useState<UserResponse["user"] | undefined>();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [threadsError, setThreadsError] = useState<string | undefined>();

  const [bootstrapped, setBootstrapped] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection | null>(() =>
      initialOpen === "settings" ? "profile" : null,
    );
  const [userDefaultModelId, setUserDefaultModelId] = useState<
    string | undefined
  >();
  const [runActionPendingId, setRunActionPendingId] = useState<string>();
  const [rightPane, setRightPane] = useState<RightPane | null>(() =>
    initialOpen === "artifacts" ? { kind: "workspace" } : null,
  );
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [oauthConnected, setOauthConnected] = useState<Record<string, boolean>>({});
  const [slashSkills, setSlashSkills] = useState<SlashSkill[]>([]);
  const [recommendationPendingId, setRecommendationPendingId] =
    useState<string>();
  const [appDraftPendingId, setAppDraftPendingId] = useState<string>();
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [editRequest, setEditRequest] = useState<ChatEditRequest>();
  const closeRightPane = useCallback(() => setRightPane(null), []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const loadingThreadsRef = useRef<Set<string>>(new Set());
  const streamAbortRef = useRef<AbortController | null>(null);
  const initialThreadAppliedRef = useRef(false);
  const pendingRunRef = useRef<{
    tabId: string;
    runId: string;
    completedAssistantIds: string[];
  } | null>(null);

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const activeLoadTabId = activeTab?.id;
  const activeLoadThreadId = activeTab?.threadId;
  const activeLoadComplete = activeTab?.loaded;
  const composerDraftKey =
    user && activeTab
      ? `${user.id}:${activeTab.threadId ?? "new"}`
      : undefined;
  const latestAppDraftIds = latestAppDraftVersionIds(
    activeTab?.messages.flatMap((message) => message.appDraftVersions ?? []) ?? [],
  );
  const inspectedRunId =
    rightPane?.kind === "inspector" ? rightPane.runId : null;
  const inspectedMessage = inspectedRunId
    ? activeTab?.messages.find((message) => message.runId === inspectedRunId)
    : undefined;

  useEffect(() => {
    const intervalId = window.setInterval(
      () => setMessageClock(Date.now()),
      60_000,
    );
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (user?.role !== "admin") return;
    const runId = new URLSearchParams(window.location.search).get("inspectRun");
    if (runId && /^[0-9a-f-]{36}$/i.test(runId)) {
      setRightPane({ kind: "inspector", runId });
    }
  }, [user?.role]);

  useEffect(() => {
    setEditRequest(undefined);
  }, [activeId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.has("connected")) {
      setSettingsSection("integrations");
    }
  }, []);

  // Unread-notification badge: poll so the count updates without a hard
  // refresh (scheduled runs complete in the background worker).
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch("/api/notifications");
        if (!res.ok) return;
        const body = (await res.json()) as { unreadCount?: number };
        if (!cancelled) setUnreadNotifications(body.unreadCount ?? 0);
      } catch {
        // Offline or transient — the next tick retries.
      }
    }
    void poll();
    const id = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  function validatestring(
    id: string | undefined,
    knownIds: Set<string>,
    fallback: string,
  ): string {
    return id && knownIds.has(id) ? (id as string) : fallback;
  }

  async function refreshThreads() {
    try {
      const r = await fetch(`/api/threads?limit=${THREADS_LIMIT}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as ThreadsResponse;
      setThreads(data.threads);
      syncTabTitlesFromThreads(data.threads);
      setThreadsError(undefined);
    } catch (err) {
      setThreadsError(err instanceof Error ? err.message : String(err));
    } finally {
      setThreadsLoading(false);
    }
  }

  function syncTabTitlesFromThreads(nextThreads: ThreadSummary[]) {
    const titleByThreadId = new Map(
      nextThreads.map((thread) => [
        thread.id,
        thread.title?.trim() || "Untitled",
      ]),
    );
    setTabs((prev) =>
      prev.map((tab) => {
        if (!tab.threadId) return tab;
        const title = titleByThreadId.get(tab.threadId);
        return title && title !== tab.title ? { ...tab, title } : tab;
      }),
    );
  }

  // Bootstrap: fetch models + threads in parallel. The sidebar owns history;
  // the chat pane starts from a single fresh conversation unless a thread route
  // explicitly asks to open one.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/models")
        .then((r) => (r.ok ? (r.json() as Promise<ModelsResponse>) : null))
        .catch(() => null),
      fetch(`/api/threads?limit=${THREADS_LIMIT}`)
        .then((r) =>
          r.ok
            ? (r.json() as Promise<ThreadsResponse>)
            : Promise.reject(new Error(`HTTP ${r.status}`)),
        )
        .catch((err) => err as Error),
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
        const nextThreads = threadsResult?.threads ?? [];
        setThreads(nextThreads);
        syncTabTitlesFromThreads(nextThreads);
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
      .then(async (r) => {
        // Middleware redirects unauthenticated users to /login before this
        // page mounts, so a 401 here means the session expired between
        // mount and this fetch. Bounce them to /login so they re-auth.
        if (r.status === 401) {
          window.location.assign("/login");
          return null;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as UserResponse;
      })
      .then((data) => {
        if (cancelled || !data?.user) return;
        setUser(data.user);
        if (data.user.defaultModelId) {
          setUserDefaultModelId(data.user.defaultModelId);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        // Surface the failure rather than silently dropping it. The user
        // chip simply stays empty until /api/user succeeds — useful when
        // debugging an auth/DB outage.
        console.error("failed to load /api/user", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Prefer the account-level default model from /api/user. The localStorage
  // read is a migration bridge for preferences saved before this became a
  // server-side profile field.
  useEffect(() => {
    if (!user?.id || typeof window === "undefined") return;
    if (user.defaultModelId) return;
    try {
      const dm = localStorage.getItem(`${DEFAULT_MODEL_PREFIX}${user.id}`);
      if (dm) setUserDefaultModelId(dm as string);
    } catch {
      /* ignore */
    }
  }, [user?.id, user?.defaultModelId]);

  // Open settings via ⌘,/Ctrl,
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsSection("profile");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  function handleProfileUpdated(next: {
    displayName: string;
    customInstructions: string | null;
    defaultModelId?: string | null;
  }) {
    setUser((prev) => (prev ? { ...prev, ...next } : prev));
  }

  async function updateUserDefaultModel(id: string) {
    if (!user?.id) return;
    try {
      if (typeof window !== "undefined") {
        localStorage.setItem(`${DEFAULT_MODEL_PREFIX}${user.id}`, id);
      }
    } catch {
      /* ignore */
    }
    setUserDefaultModelId(id);
    setUser((prev) => (prev ? { ...prev, defaultModelId: id } : prev));

    try {
      const res = await fetch("/api/user", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultModelId: id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as UserResponse;
      setUser(body.user);
      setUserDefaultModelId(body.user.defaultModelId ?? id);
    } catch (err) {
      console.error("failed to save default model", err);
    }
  }

  // Validate the active conversation's modelId against the loaded registry.
  // Runs whenever the registry changes; idempotent for already-valid chats.
  useEffect(() => {
    if (models.length === 0) return;
    const validIds = new Set(models.map((m) => m.id));
    setTabs((prev) =>
      prev.map((t) =>
        t.modelId && validIds.has(t.modelId)
          ? t
          : { ...t, modelId: defaultModelId },
      ),
    );
  }, [models, defaultModelId]);

  // If the account-level default model arrives after the initial model list,
  // keep blank new chats aligned with the user's preference. Existing threads
  // keep their saved per-thread model.
  useEffect(() => {
    if (models.length === 0 || !userDefaultModelId) return;
    const validIds = new Set(models.map((m) => m.id));
    if (!validIds.has(userDefaultModelId)) return;
    setTabs((prev) =>
      prev.map((t) =>
        !t.threadId && t.messages.length === 0
          ? { ...t, modelId: userDefaultModelId }
          : t,
      ),
    );
  }, [models, userDefaultModelId]);

  // The sidebar is the conversation navigator. Once the user profile is known,
  // the active chat is ready; old saved sessions intentionally do not restore
  // into a second navigation model.
  useEffect(() => {
    if (!user?.id || bootstrapped) return;
    setBootstrapped(true);
  }, [user?.id, bootstrapped]);

  useEffect(() => {
    if (!initialThreadId || !bootstrapped || initialThreadAppliedRef.current) {
      return;
    }
    initialThreadAppliedRef.current = true;
    const thread = threads.find((t) => t.id === initialThreadId);
    const validIds = new Set(models.map((m) => m.id));
    const modelId = validatestring(
      thread?.defaultModelId,
      validIds,
      defaultModelId,
    );
    const tab: ChatTab = {
      id: crypto.randomUUID(),
      title: thread?.title?.trim() || `Thread ${initialThreadId.slice(0, 8)}`,
      threadId: initialThreadId,
      messages: [],
      modelId,
      busy: false,
      loaded: false,
    };
    setTabs([tab]);
    setActiveId(tab.id);
  }, [initialThreadId, bootstrapped, threads, models, defaultModelId]);

  // Keep activeId pointing at a real tab. If the active tab is removed (e.g.
  // a stale thread is dropped after a 404), fall back to the first tab.
  useEffect(() => {
    if (tabs.length === 0) return;
    if (tabs.some((t) => t.id === activeId)) return;

    const timeout = window.setTimeout(() => {
      setActiveId((current) =>
        tabs.some((t) => t.id === current) ? current : tabs[0]!.id,
      );
    }, 0);
    return () => {
      window.clearTimeout(timeout);
    }
  }, [tabs, activeId]);

  // Lazy-load messages for the active conversation when it becomes active.
  useEffect(() => {
    if (!activeLoadTabId || activeLoadComplete || !activeLoadThreadId) return;
    if (loadingThreadsRef.current.has(activeLoadTabId)) return;
    loadingThreadsRef.current.add(activeLoadTabId);
    let cancelled = false;
    const tabId = activeLoadTabId;
    const threadId = activeLoadThreadId;
    fetch(`/api/threads/${threadId}/messages`)
      .then((r) =>
        r.ok
          ? (r.json() as Promise<ThreadMessagesResponse>)
          : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((data) => {
        if (cancelled) return;
        const msgs = data.messages.map(threadMessageToUiMessage);
        setTabs((prev) =>
          prev.map((t) => {
            if (t.id !== tabId) return t;
            return {
              ...t,
              messages: mergeLoadedMessages(msgs, t.messages),
              loaded: true,
            };
          }),
        );
        // Reset stick-to-bottom on initial load so we land at the latest message.
        stickToBottomRef.current = true;
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        const isMissing = /HTTP 404|thread_not_found/i.test(message);
        if (isMissing) {
          setTabs([makeFreshTab(defaultModelId)]);
          return;
        }
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? { ...t, error: `failed to load messages: ${message}` }
              : t,
          ),
        );
      })
      .finally(() => {
        loadingThreadsRef.current.delete(tabId);
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeLoadComplete,
    activeLoadTabId,
    activeLoadThreadId,
    defaultModelId,
  ]);

  // First-run welcome tour (#136): show once per user, the first time the
  // profile loads with tour_completed_at unset. Finishing or skipping
  // persists completion; Settings can replay it any time.
  useEffect(() => {
    if (user && shouldShowTour(user)) {
      setWizardOpen(true);
      // Provider status drives the wizard's connect step (and resume).
      fetch("/api/oauth/status", { credentials: "include" })
        .then((r) => (r.ok ? r.json() : {}))
        .then((s) => setOauthConnected(s as Record<string, boolean>))
        .catch(() => {});
    }
  }, [user]);

  // Skills for the "/" capability palette (#144). Loaded once; the list is
  // small and a selected skill now activates hidden context for the next chat
  // turn instead of navigating away from the composer.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/skills")
      .then(async (r) => {
        if (!r.ok) return;
        const body = (await r.json()) as {
          skills?: Array<{
            id: string;
            slug: string;
            name: string;
            description: string | null;
            mcpProviders: string[];
            isStarter: boolean;
            sharedWithMe: boolean;
          }>;
        };
        if (!cancelled && Array.isArray(body.skills)) {
          setSlashSkills(body.skills);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const completeWizard = () => {
    setWizardOpen(false);
    if (user && user.tourCompletedAt === null) {
      setUser({ ...user, tourCompletedAt: new Date().toISOString() });
      void fetch("/api/user", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tourCompleted: true }),
      }).catch(() => {});
    }
  };

  const saveWizardStep = async (patch: {
    assistantName?: string;
    onboarding?: { role?: string; tools?: string[]; firstTask?: string };
  }) => {
    try {
      const res = await fetch("/api/user", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const body = (await res.json()) as UserResponse;
        setUser(body.user);
      }
    } catch {
      /* non-fatal — the wizard continues */
    }
  };

  const activeHasPendingRun =
    activeTab?.messages.some((m) => m.pending && m.id.startsWith("run:")) ??
    false;
  const activeTabId = activeTab?.id;
  const activePendingRunId =
    activeTab?.messages.find((m) => m.pending && m.id.startsWith("run:"))
      ?.id ?? null;
  // The run's database id, for the slim status poll (#447). Placeholder ids
  // are always `run:<uuid>`.
  const activePendingRunDbId =
    activePendingRunId?.slice("run:".length) ?? null;
  const completedAssistantSignature =
    activeTab?.messages
      .filter((message) => message.role === "assistant" && !message.pending)
      .map((message) => message.id)
      .join("\u0000") ?? "";

  useEffect(() => {
    const completedAssistantIds = completedAssistantSignature
      ? completedAssistantSignature.split("\u0000")
      : [];
    const previous = pendingRunRef.current;
    const current =
      activeTabId && activePendingRunId
        ? {
            tabId: activeTabId,
            runId: activePendingRunId,
            completedAssistantIds,
          }
        : null;
    pendingRunRef.current = current;
    const terminalResultVisible = previous
      ? completedAssistantIds.some(
          (id) =>
            id === previous.runId ||
            !previous.completedAssistantIds.includes(id),
        )
      : false;

    if (
      !previous ||
      current ||
      previous.tabId !== activeTabId ||
      !terminalResultVisible ||
      !document.hidden
    ) {
      return;
    }

    const previousTitle = document.title;
    let restored = false;
    document.title = BACKGROUND_COMPLETION_TITLE;

    function restoreTitle() {
      if (restored) return;
      restored = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", restoreTitle);
      if (document.title === BACKGROUND_COMPLETION_TITLE) {
        document.title = previousTitle;
      }
    }

    function handleVisibilityChange() {
      if (!document.hidden) restoreTitle();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", restoreTitle);
    return restoreTitle;
  }, [
    activeTabId,
    activePendingRunId,
    completedAssistantSignature,
  ]);

  // Keep a stable handle on refreshThreads for the polling effect below —
  // it's redefined every render, and subscribing the interval to it would
  // tear the poller down on every keystroke.
  const refreshThreadsRef = useRef(refreshThreads);
  useEffect(() => {
    refreshThreadsRef.current = refreshThreads;
  });

  // Background runs no longer keep the `/api/chat` request open. While a
  // pending run placeholder is visible, poll the run's slim status endpoint
  // (#447) and reload the full thread — messages + events + artifact
  // content — only when the status/event cursor actually moved. The old poll
  // refetched the whole thread every 500ms and discarded it when nothing had
  // changed.
  useEffect(() => {
    if (!activeTab?.threadId || !activePendingRunDbId) return;
    const tabId = activeTab.id;
    const threadId = activeTab.threadId;
    const runId = activePendingRunDbId;
    let cancelled = false;
    let cursor: RunStatusSnapshot | null = null;

    async function refreshPendingRun(): Promise<boolean> {
      try {
        const r = await fetch(`/api/threads/${threadId}/messages`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as ThreadMessagesResponse;
        if (cancelled) return false;
        const msgs = data.messages.map(threadMessageToUiMessage);
        const hasLoadedPending = msgs.some((m) => m.pending);
        setTabs((prev) =>
          prev.map((t) => {
            if (t.id !== tabId) return t;
            const merged = mergeLoadedMessages(msgs, t.messages);
            return {
              ...t,
              messages: hasLoadedPending
                ? merged
                : merged.filter(
                    (m) => !(m.pending && m.id.startsWith("run:")),
                  ),
              loaded: true,
            };
          }),
        );
        if (!hasLoadedPending) void refreshThreadsRef.current();
        return true;
      } catch (err) {
        if (!cancelled) {
          console.error("failed to refresh pending run", err);
        }
        return false;
      }
    }

    async function pollRunStatus() {
      try {
        const r = await fetch(`/api/runs/${runId}/status`);
        if (cancelled) return;
        if (!r.ok) {
          // Fail open to the pre-#447 behavior: a vanished run (404) still
          // needs the full reload to clear its placeholder.
          void refreshPendingRun();
          return;
        }
        const data = (await r.json()) as RunStatusResponse;
        const next: RunStatusSnapshot = {
          status: data.run.status,
          latestEventSequence: data.run.latestEventSequence,
        };
        if (shouldReloadThread(cursor, next)) {
          const reloaded = await refreshPendingRun();
          if (!reloaded) return; // keep the cursor; retry next tick
        }
        cursor = next;
      } catch (err) {
        if (!cancelled) {
          console.error("failed to poll pending run status", err);
        }
      }
    }

    void refreshPendingRun();
    const interval = setInterval(pollRunStatus, RUN_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeTab?.id, activeTab?.threadId, activePendingRunDbId]);

  // Auto-scroll: only if user is at (or near) the bottom.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activeTab?.messages]);

  // Conversation switch: re-stick to bottom and jump there.
  useEffect(() => {
    stickToBottomRef.current = true;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activeId]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
    stickToBottomRef.current = distance < STICK_BOTTOM_THRESHOLD;
  }

  function patchTab(id: string, patch: Partial<ChatTab>) {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
  }

  function patchTabMessages(
    id: string,
    fn: (msgs: UiMessage[]) => UiMessage[],
  ) {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, messages: fn(t.messages) } : t)),
    );
  }

  function freshTabModel(): string {
    if (userDefaultModelId && models.some((m) => m.id === userDefaultModelId)) {
      return userDefaultModelId;
    }
    return defaultModelId;
  }

  function newTab() {
    stopStreaming();
    const t = makeFreshTab(freshTabModel());
    setTabs([t]);
    setActiveId(t.id);
    setRightPane(null);
  }

  function openThread(
    threadId: string,
    title: string,
    initialMessages: UiMessage[] = [],
  ) {
    setRightPane(null);
    const existing = activeTab?.threadId === threadId ? activeTab : undefined;
    if (existing) {
      if (initialMessages.length > 0) {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === existing.id
              ? {
                  ...t,
                  messages: mergeLoadedMessages(t.messages, initialMessages),
                }
              : t,
          ),
        );
      }
      setActiveId(existing.id);
      return;
    }
    stopStreaming();
    const thread = threads.find((t) => t.id === threadId);
    const validIds = new Set(models.map((m) => m.id));
    const modelId = validatestring(
      thread?.defaultModelId,
      validIds,
      defaultModelId,
    );
    const trimmed = title.trim();
    const tab: ChatTab = {
      id: crypto.randomUUID(),
      title: trimmed.length > 0 ? trimmed : "Untitled",
      threadId,
      messages: initialMessages,
      modelId,
      busy: false,
      loaded: initialMessages.length > 0,
    };
    setTabs([tab]);
    setActiveId(tab.id);
  }

  function handleModelChange(id: string) {
    if (!activeTab) return;
    patchTab(activeTab.id, { modelId: id });
  }

  async function handleRenameThread(threadId: string, title: string) {
    const res = await fetch(`/api/threads/${threadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    setThreads((prev) =>
      prev.map((t) => (t.id === threadId ? { ...t, title } : t)),
    );
    setTabs((prev) =>
      prev.map((t) => (t.threadId === threadId ? { ...t, title } : t)),
    );
  }

  async function handleDeleteThread(threadId: string) {
    const res = await fetch(`/api/threads/${threadId}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      throw new Error(`HTTP ${res.status}`);
    }
    setThreads((prev) => prev.filter((t) => t.id !== threadId));
    if (activeTab?.threadId === threadId) {
      const fresh = makeFreshTab(freshTabModel());
      setTabs([fresh]);
      setActiveId(fresh.id);
      setRightPane(null);
    }
  }

  function handleNavSelect(id: string) {
    if (id === "chat") {
      setRightPane(null);
    } else if (id === "settings") {
      setSettingsSection("profile");
      setRightPane(null);
    } else if (id === "workspace") {
      setRightPane({ kind: "workspace" });
    } else if (id === "feedback") {
      setFeedbackOpen(true);
    } else if (id === "admin") {
      router.push("/admin");
    }
  }

  function openArtifactPreview(artifact: WorkspaceArtifactSummary) {
    setRightPane({ kind: "artifact", artifact });
  }

  function openRunInspector(runId: string) {
    setRightPane({ kind: "inspector", runId });
  }

  function patchRecommendation(
    recommendation: PersistedRecommendation,
    status: RecommendationStatus,
  ) {
    setTabs((prev) =>
      prev.map((tab) => ({
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
      const res = await fetch(`/api/recommendations/${recommendation.dbId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        recommendation?: PersistedRecommendation;
        message?: string;
        error?: string;
      };
      if (!res.ok || !body.recommendation) {
        throw new Error(body.message ?? body.error ?? "Recommendation update failed");
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
        const name = appNameFromRecommendation(recommendation);
        const appRes = await fetch("/api/apps", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            artifactId: recommendation.action.artifactId,
            name,
            description: recommendation.reason,
          }),
        });
        const appBody = (await appRes.json().catch(() => ({}))) as {
          app?: { id?: string };
          message?: string;
          error?: string;
        };
        if (!appRes.ok || !appBody.app?.id) {
          throw new Error(appBody.message ?? appBody.error ?? "Could not deploy app.");
        }
        window.location.assign(`/apps/manage/${appBody.app.id}`);
      } else if (recommendation.action.kind === "create_skill") {
        window.location.assign("/skills/new");
      }
    } catch (err) {
      patchTab(activeTab.id, {
        error:
          err instanceof Error
            ? err.message
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
      const res = await fetch(`/api/apps/${version.appId}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appVersionId: version.id }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        url?: string;
        message?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body.message ?? body.error ?? "Could not deploy update.");
      }
      setTabs((prev) =>
        prev.map((tab) => {
          const current = tab.messages.flatMap(
            (message) => message.appDraftVersions ?? [],
          );
          if (!current.some((candidate) => candidate.id === version.id)) {
            return tab;
          }
          const updated = markAppDraftVersionDeployed(
            current,
            version.id,
            body.url,
          );
          const updatedById = new Map(
            updated.map((candidate) => [candidate.id, candidate]),
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
    } catch (err) {
      patchTab(activeTab.id, {
        error:
          err instanceof Error ? err.message : "Could not deploy update.",
      });
    } finally {
      setAppDraftPendingId(undefined);
    }
  }

  function downloadActiveChat() {
    if (!activeTab || activeTab.messages.length === 0) return;
    const exportedAt = new Date();
    const markdown = buildChatTranscriptMarkdown({
      title: activeTab.title,
      threadId: activeTab.threadId,
      messages: activeTab.messages,
      exportedAt,
    });
    downloadTextFile({
      filename: chatTranscriptFilename({
        title: activeTab.title,
        exportedAt,
      }),
      content: markdown,
      mimeType: "text/markdown;charset=utf-8",
    });
  }

  async function send(
    text: string,
    attachments?: ChatAttachment[],
    activatedSkill?: ActivatedSlashSkill,
    modelOverride?: ChatModelOverride,
    replaceMessageId?: string,
  ) {
    if (!activeTab || activeTab.busy) return;
    if (!text.trim() && (!attachments || attachments.length === 0)) return;
    const tabId = activeTab.id;
    const replaceIndex = replaceMessageId
      ? activeTab.messages.findIndex(
          (message) => message.id === replaceMessageId && message.role === "user",
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
    patchTabMessages(tabId, (prev) => {
      // A file-turn edit sends no NEW attachments but replays the stored
      // ones (#348) — the optimistic bubble must inherit the replaced
      // message's chips and replayability or the turn visibly loses its
      // files (and its re-edit affordance) until a reload.
      const replaced = replaceMessageId
        ? prev.find((message) => message.id === replaceMessageId)
        : undefined;
      const replayedUploadCount =
        replaced?.artifacts?.filter(
          (artifact) => artifact.source === "user-upload",
        ).length ?? 0;
      // User bubbles surface files via the 📎 content note (artifact pills
      // are assistant-only) — a replay edit restores it from the replaced
      // message so the files don't visibly vanish.
      const replayNote =
        !attachmentNote && replayedUploadCount > 0
          ? `\n\n📎 ${replayedUploadCount} file${replayedUploadCount === 1 ? "" : "s"} attached`
          : "";
      return [
        ...(replaceMessageId ? prev.slice(0, replaceIndex) : prev),
        {
          id: userMsgId,
          role: "user",
          content: `${text}${attachmentNote}${replayNote}`,
          createdAt: turnCreatedAt,
          hasAttachments:
            Boolean(attachments?.length) || Boolean(replaced?.hasAttachments),
          // A fresh upload is replayable by construction once persisted; a
          // replayed edit stays exactly as replayable as it already was.
          attachmentsReplayable: replaced
            ? replaced.attachmentsReplayable
            : Boolean(attachments?.length),
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

    // New message from the user — re-stick to bottom.
    stickToBottomRef.current = true;

    const abort = new AbortController();
    streamAbortRef.current = abort;
    let responseAccepted = false;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abort.signal,
        body: JSON.stringify({
          message: text,
          threadId: activeTab.threadId,
          modelId: requestedModelId,
          // #432: ground "today"/"tomorrow" in the browser's zone. The server
          // validates it as a real IANA zone and ignores anything else.
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(modelOverride?.mode === "model" ? { modelOverride: true } : {}),
          attachmentCount: attachments?.length ?? 0,
          ...(activatedSkill ? { activatedSkills: [activatedSkill] } : {}),
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
          ...(replaceMessageId ? { replaceMessageId } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      responseAccepted = true;

      let assistantText = "";
      let assistantModel: string | undefined;
      let assistantLane: ChatRuntimeLane | undefined;
      let queuedRun = false;
      let queuedRunMessageId: string | undefined;
      let streamRunId: string | undefined;
      let assistantDraftId = assistantMsgId;
      const isDraftMessage = (m: UiMessage) =>
        m.id === assistantMsgId || m.id === assistantDraftId;

      for await (const ev of readSseStream<ChatStreamEvent>(res)) {
        if (ev.type === "meta") {
          if (typeof ev.threadId === "string") {
            patchTab(tabId, { threadId: ev.threadId });
          }
          if (typeof ev.userMessageId === "string") {
            patchTabMessages(tabId, (prev) =>
              prev.map((message) =>
                message.id === userMsgId
                  ? { ...message, id: ev.userMessageId as string, persisted: true }
                  : message,
              ),
            );
          }
          if (typeof ev.modelId === "string") assistantModel = ev.modelId;
          const route = ev.runtimeRoute as
            | { useWorker?: unknown; lane?: unknown }
            | undefined;
          assistantLane = parseRuntimeLane(route?.lane);
          if (typeof ev.runId === "string") {
            streamRunId = ev.runId;
            patchTabMessages(tabId, (prev) =>
              prev.map((message) =>
                isDraftMessage(message)
                  ? {
                      ...message,
                      modelId: assistantModel,
                      runtimeLane: assistantLane,
                      runId: streamRunId,
                    }
                  : message,
              ),
            );
          }
          if (streamRunId && route?.useWorker === true) {
            const runMessageId = `run:${streamRunId}`;
            queuedRunMessageId = runMessageId;
            assistantDraftId = runMessageId;
            patchTabMessages(tabId, (prev) =>
              prev.map((m) =>
                m.id === assistantMsgId
                  ? {
                      ...m,
                      id: runMessageId,
                      modelId: assistantModel,
                      runtimeLane: assistantLane,
                      runId: streamRunId,
                    }
                  : m,
              ),
            );
          }
        } else if (ev.type === "model" && typeof ev.modelId === "string") {
          assistantModel = ev.modelId;
          patchTabMessages(tabId, (prev) =>
            prev.map((m) =>
              isDraftMessage(m)
                ? {
                    ...m,
                    modelId: assistantModel,
                    runtimeLane: assistantLane,
                  }
                : m,
            ),
          );
        } else if (ev.type === "text-delta" && typeof ev.delta === "string") {
          assistantText += ev.delta;
          patchTabMessages(tabId, (prev) =>
            prev.map((m) =>
              isDraftMessage(m)
                ? {
                    ...m,
                    content: assistantText,
                    pending: true,
                    status: undefined,
                    modelId: assistantModel,
                    runtimeLane: assistantLane,
                    livePhase: "finalizing",
                  }
                : m,
            ),
          );
        } else if (
          ev.type === "usage" &&
          typeof ev.tokensIn === "number" &&
          typeof ev.tokensOut === "number"
        ) {
          // #359: live token totals for the run footer; the authoritative
          // final values still arrive with `persisted`.
          const tokensIn = ev.tokensIn;
          const tokensOut = ev.tokensOut;
          patchTabMessages(tabId, (prev) =>
            prev.map((m) =>
              isDraftMessage(m) ? { ...m, liveTokens: tokensIn + tokensOut } : m,
            ),
          );
        } else if (ev.type === "metrics" && ev.stage === "provider_started") {
          patchTabMessages(tabId, (prev) =>
            prev.map((m) =>
              isDraftMessage(m) && !m.livePhase
                ? { ...m, livePhase: "planning" }
                : m,
            ),
          );
        } else if (
          ev.type === "provider-reasoning-delta" &&
          typeof ev.iteration === "number" &&
          typeof ev.blockIndex === "number" &&
          typeof ev.delta === "string"
        ) {
          patchTabMessages(tabId, (prev) =>
            prev.map((m) =>
              isDraftMessage(m)
                ? {
                    ...m,
                    providerReasoning: updateLiveReasoning(
                      m.providerReasoning,
                      {
                        iteration: ev.iteration as number,
                        blockIndex: ev.blockIndex as number,
                        delta: ev.delta as string,
                      },
                    ),
                  }
                : m,
            ),
          );
        } else if (
          ev.type === "provider-reasoning-redacted" &&
          typeof ev.iteration === "number" &&
          typeof ev.blockIndex === "number"
        ) {
          patchTabMessages(tabId, (prev) =>
            prev.map((m) =>
              isDraftMessage(m)
                ? {
                    ...m,
                    providerReasoning: updateLiveReasoning(
                      m.providerReasoning,
                      {
                        iteration: ev.iteration as number,
                        blockIndex: ev.blockIndex as number,
                        redacted: true,
                      },
                    ),
                  }
                : m,
            ),
          );
        } else if (ev.type === "tool-call") {
          const persistedCall = streamToolCallToPersisted(ev.call);
          const name = persistedCall?.name;
          const status = name
            ? `Calling ${formatToolName(name)}…`
            : "Calling tool…";
          patchTabMessages(tabId, (prev) =>
            prev.map((m) =>
              isDraftMessage(m)
                ? {
                    ...m,
                    status,
                    livePhase: "using tools",
                    toolCalls: persistedCall
                      ? upsertToolCall(m.toolCalls, persistedCall)
                      : m.toolCalls,
                  }
                : m,
            ),
          );
        } else if (ev.type === "tool-result") {
          // Tool finished. If no text has streamed yet, fall back to a
          // generic "Working…" so the indicator doesn't blink back to the
          // initial "Thinking…" between chained tool calls.
          patchTabMessages(tabId, (prev) =>
            prev.map((m) =>
              isDraftMessage(m)
                ? {
                    ...m,
                    status: m.content.length === 0 ? "Working…" : m.status,
                    toolResults: (() => {
                      const persistedResult = streamToolResultToPersisted(
                        ev.result,
                        m.toolCalls ?? [],
                      );
                      return persistedResult
                        ? upsertToolResult(m.toolResults, persistedResult)
                        : m.toolResults;
                    })(),
                  }
                : m,
            ),
          );
        } else if (ev.type === "queued") {
          queuedRun = true;
          const status =
            typeof ev.status === "string"
              ? ev.status
              : "Queued for background worker";
          patchTabMessages(tabId, (prev) =>
            prev.map((m) =>
              m.id === assistantMsgId ||
              (typeof ev.runId === "string" && m.id === `run:${ev.runId}`)
                ? {
                    ...m,
                    id:
                      typeof ev.runId === "string"
                        ? `run:${ev.runId}`
                        : m.id,
                    pending: true,
                    status,
                    modelId: assistantModel,
                    runtimeLane: assistantLane,
                  }
                : m,
            ),
          );
        } else if (ev.type === "error" && typeof ev.message === "string") {
          throw new Error(ev.message);
        } else if (ev.type === "done") {
          // wait for `persisted`
        } else if (ev.type === "persisted") {
          const persistedAssistantMessageId =
            typeof ev.assistantMessageId === "string"
              ? ev.assistantMessageId
              : undefined;
          const artifacts = Array.isArray(ev.artifacts)
            ? (ev.artifacts as WorkspaceArtifactSummary[])
            : undefined;
          const appDraftVersions = parseAppDraftVersionSummaries(
            ev.appDraftVersions,
          );
          const recommendations = Array.isArray(ev.recommendations)
            ? (ev.recommendations as PersistedRecommendation[])
            : undefined;
          const tokensIn =
            typeof ev.tokensIn === "number" ? ev.tokensIn : undefined;
          const tokensOut =
            typeof ev.tokensOut === "number" ? ev.tokensOut : undefined;
          patchTabMessages(tabId, (prev) =>
            prev.map((m) =>
              isDraftMessage(m)
                ? {
                    ...m,
                    id: persistedAssistantMessageId ?? m.id,
                    pending: false,
                    status: undefined,
                    livePhase: undefined,
                    liveTokens: undefined,
                    modelId: assistantModel,
                    runtimeLane: assistantLane,
                    artifacts,
                    appDraftVersions,
                    recommendations,
                    tokensIn,
                    tokensOut,
                    runId: streamRunId ?? m.runId,
                    runStatus: "succeeded",
                    canCancel: false,
                    canRetry: false,
                    canResume: false,
                  }
                : m,
            ),
          );
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

      patchTabMessages(tabId, (prev) =>
        prev.map((m) =>
          isDraftMessage(m) ||
          (queuedRunMessageId !== undefined && m.id === queuedRunMessageId)
            ? {
                ...m,
                pending: queuedRun,
                status: queuedRun ? m.status : undefined,
                ...(queuedRun
                  ? {}
                  : {
                      runId: streamRunId ?? m.runId,
                      runStatus: "succeeded",
                      canCancel: false,
                      canRetry: false,
                      canResume: false,
                    }),
              }
            : m,
        ),
      );

      // Sidebar history may now have a new or moved-up entry.
      void refreshThreads();
    } catch (err) {
      // A user-initiated Stop aborts the fetch — not an error to surface.
      if (err instanceof DOMException && err.name === "AbortError") {
        patchTabMessages(tabId, (prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? { ...m, pending: false, status: undefined }
              : m,
          ),
        );
        return;
      }
      const message = formatChatError(err);
      patchTab(tabId, { error: message });
      if (replaceMessageId && !responseAccepted) {
        patchTabMessages(tabId, () => originalMessages);
        return;
      }
      patchTabMessages(tabId, (prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? { ...m, pending: false, status: undefined }
            : m,
        ),
      );
    } finally {
      if (streamAbortRef.current === abort) streamAbortRef.current = null;
      patchTab(tabId, { busy: false });
      // If the user stopped mid-stream before any text arrived, drop the empty
      // assistant stub so the turn doesn't look frozen.
      patchTabMessages(tabId, (prev) =>
        prev.filter(
          (m) =>
            !(
              m.id === assistantMsgId &&
              m.pending &&
              m.content.length === 0
            ),
        ),
      );
    }
  }

  function stopStreaming() {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
  }

  // Regenerate the last assistant answer: re-run the last user turn.
  function regenerate() {
    retry();
  }

  const canRegenerate =
    !activeTab?.busy &&
    !activeHasPendingRun &&
    (activeTab?.messages.some((m) => m.role === "assistant" && !m.pending) ??
      false);

  function retry() {
    if (!activeTab) return;
    const msgs = activeTab.messages;
    let lastUserIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]!.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return;
    const lastUserMessage = msgs[lastUserIdx]!;
    const lastUserText = lastUserMessage.content;
    const tabId = activeTab.id;
    patchTab(tabId, { error: undefined });
    if (!lastUserMessage.persisted) {
      patchTabMessages(tabId, (prev) => prev.slice(0, lastUserIdx));
    }
    void send(
      lastUserText,
      undefined,
      undefined,
      undefined,
      lastUserMessage.persisted ? lastUserMessage.id : undefined,
    );
  }

  async function refreshActiveThreadMessages(tabId: string, threadId: string) {
    const r = await fetch(`/api/threads/${threadId}/messages`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = (await r.json()) as ThreadMessagesResponse;
    const msgs = data.messages.map(threadMessageToUiMessage);
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId
          ? { ...t, messages: mergeLoadedMessages(msgs, t.messages), loaded: true }
          : t,
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
      const res = await fetch(`/api/runs/${runId}/${action}`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body.message ?? body.error ?? `${action} failed`);
      }
      await refreshActiveThreadMessages(activeTab.id, activeTab.threadId);
      void refreshThreads();
    } catch (err) {
      patchTab(activeTab.id, {
        error: err instanceof Error ? err.message : `${action} failed`,
      });
    } finally {
      setRunActionPendingId(undefined);
    }
  }

  useRegisterCommandPaletteActions({
    newChat: () => {
      setSettingsSection(null);
      newTab();
    },
    openArtifacts: () => {
      setSettingsSection(null);
      setRightPane({ kind: "workspace" });
    },
    openSettings: () => {
      setSettingsSection("profile");
      setRightPane(null);
    },
    openThread: (threadId, title) => {
      setSettingsSection(null);
      openThread(threadId, title);
    },
  });

  if (!activeTab) return null;
  const { busy, error, messages } = activeTab;
  const inputDisabled = busy || activeHasPendingRun || models.length === 0;
  const lastAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  const resolvedModel = lastAssistantMessage?.modelId
    ? models.find((model) => model.id === lastAssistantMessage.modelId)
    : undefined;
  const resolvedModelName =
    resolvedModel?.displayName ?? lastAssistantMessage?.modelId;
  const compactResolvedModelName = compactModelName(resolvedModelName);
  const resolvedLaneName = runtimeLaneLabel(lastAssistantMessage?.runtimeLane);
  const lastArtifact = [...messages]
    .reverse()
    .flatMap((message) => message.artifacts ?? [])
    .find(Boolean);
  const feedbackContext: FeedbackContext = {
    threadId: activeTab.threadId,
    threadTitle: activeTab.title,
    messageId:
      lastAssistantMessage?.id && !lastAssistantMessage.id.startsWith("run:")
        ? lastAssistantMessage.id
        : undefined,
    messagePreview: lastAssistantMessage?.content
      ? lastAssistantMessage.content.slice(0, 600)
      : undefined,
    runId: lastAssistantMessage?.runId,
    artifactId: lastArtifact?.id,
    artifactTitle: lastArtifact?.title ?? lastArtifact?.filename,
  };

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-canvas text-ink">
      <Sidebar
        userName={user?.displayName}
        userEmail={user?.email}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNewChat={newTab}
        onSearch={openPalette}
        autoCollapse={rightPane !== null}
        threads={threads}
        threadsLoading={threadsLoading}
        threadsError={threadsError}
        activeThreadId={
          rightPane?.kind !== "workspace" ? activeTab.threadId : undefined
        }
        onOpenThread={openThread}
        activeNavId={rightPane?.kind === "workspace" ? "workspace" : "chat"}
        onNavSelect={handleNavSelect}
        isAdmin={user?.role === "admin"}
        onSignOut={() => signOut({ callbackUrl: "/login" })}
        onRenameThread={handleRenameThread}
        onDeleteThread={handleDeleteThread}
      />

      <main className="flex h-full min-w-0 flex-1 overflow-hidden">
        <section
          data-testid="chat-workspace-pane"
          className="flex h-full min-w-0 flex-1 flex-col"
        >
          <header className="flex h-11 shrink-0 items-center justify-between border-b border-hairline bg-canvas">
                <button
                  type="button"
                  onClick={() => setSidebarOpen(true)}
                  aria-label="Open menu"
                  className="flex h-11 w-11 shrink-0 items-center justify-center text-muted hover:bg-subtle hover:text-ink md:hidden"
                >
                  <svg
                    viewBox="0 0 16 16"
                    width="16"
                    height="16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M2 4h12M2 8h12M2 12h12" />
                  </svg>
                </button>
                <div className="flex min-w-0 flex-1 items-center px-3">
                  <div
                    data-testid="active-chat-title"
                    className="truncate text-sm font-medium text-muted"
                    title={activeTab.title}
                  >
                    {activeTab.threadId ? activeTab.title : "New chat"}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1 px-2 sm:gap-1.5 sm:px-3">
                  {!runtimeV2Enabled &&
                  models.length > 0 &&
                  activeTab.modelId ? (
                    <ModelSelector
                      value={activeTab.modelId}
                      onChange={handleModelChange}
                      options={models}
                      disabled={busy || activeHasPendingRun}
                    />
                  ) : null}
                  {runtimeV2Enabled ? (
                    <div
                      data-testid="resolved-model-chip"
                      aria-label={
                        resolvedModelName
                          ? `Resolved model: ${resolvedModelName}${resolvedLaneName ? `, ${resolvedLaneName} lane` : ""}`
                          : "Model selected automatically when the assistant responds"
                      }
                      title={
                        resolvedModelName
                          ? `Resolved model: ${resolvedModelName}${resolvedLaneName ? ` · ${resolvedLaneName} lane` : ""}`
                          : "Comparative selects the model automatically for each turn"
                      }
                      className="flex h-7 min-w-0 max-w-20 shrink items-center gap-1.5 rounded-full border border-hairline bg-subtle px-2 text-2xs text-muted sm:max-w-56"
                    >
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-info" />
                      <span className="min-w-0 truncate sm:hidden">
                        {compactResolvedModelName ?? "Auto"}
                      </span>
                      <span className="hidden min-w-0 truncate sm:inline">
                        {resolvedModelName ?? "Auto model"}
                      </span>
                      {resolvedLaneName ? (
                        <span className="hidden shrink-0 border-l border-hairline pl-1.5 sm:inline">
                          {resolvedLaneName}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    aria-label={
                      unreadNotifications > 0
                        ? `Notifications (${unreadNotifications} unread)`
                        : "Notifications"
                    }
                    title="Notifications"
                    data-testid="notification-bell"
                    onClick={() =>
                      setRightPane((current) =>
                        current?.kind === "notifications"
                          ? null
                          : { kind: "notifications" },
                      )
                    }
                    className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-hairline bg-canvas text-muted hover:bg-subtle hover:text-ink"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      width="14"
                      height="14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M8 2a3.5 3.5 0 0 0-3.5 3.5c0 3-1.5 4.5-1.5 4.5h10s-1.5-1.5-1.5-4.5A3.5 3.5 0 0 0 8 2Z" />
                      <path d="M6.8 12.5a1.3 1.3 0 0 0 2.4 0" />
                    </svg>
                    {unreadNotifications > 0 ? (
                      <span
                        data-testid="notification-badge"
                        className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-2xs font-semibold text-on-accent"
                      >
                        {unreadNotifications > 9 ? "9+" : unreadNotifications}
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    aria-label="Download chat transcript"
                    title="Download chat transcript"
                    disabled={messages.length === 0}
                    onClick={downloadActiveChat}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-hairline bg-canvas text-muted hover:bg-subtle hover:text-ink disabled:opacity-40"
                  >
                    <DownloadIcon />
                  </button>
                  {busy ? (
                    <button
                      type="button"
                      aria-label="Stop generating"
                      title="Stop generating"
                      onClick={stopStreaming}
                      className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-hairline bg-canvas px-2 text-xs font-medium text-muted hover:bg-subtle hover:text-ink"
                    >
                      <span className="block h-2.5 w-2.5 rounded-xs bg-current" />
                      Stop
                    </button>
                  ) : canRegenerate ? (
                    <button
                      type="button"
                      aria-label="Regenerate last response"
                      title="Regenerate last response"
                      onClick={regenerate}
                      className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-hairline bg-canvas px-2 text-xs font-medium text-muted hover:bg-subtle hover:text-ink"
                    >
                      <svg
                        viewBox="0 0 16 16"
                        width="13"
                        height="13"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2v3h-3" />
                      </svg>
                      Regenerate
                    </button>
                  ) : null}
                  <ThemeToggle />
                </div>
          </header>

        <div
          ref={scrollRef}
          data-testid="chat-scroll-region"
          onScroll={handleScroll}
          className="flex-1 overflow-x-hidden overflow-y-auto"
        >
          <div
            data-density="messages"
            className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8"
          >
            {messages.length === 0 ? (
              <EmptyState
                onPick={send}
                onOpenIntegrations={() => setSettingsSection("integrations")}
              />
            ) : (
              messages.map((m) => (
                <div key={m.id} className="flex flex-col gap-2">
                  <MessageBubble
                    role={m.role}
                    content={m.content}
                    createdAt={m.createdAt}
                    nowMs={messageClock}
                    modelId={m.modelId}
                    tokensIn={m.tokensIn}
                    tokensOut={m.tokensOut}
                    pending={m.pending}
                    status={m.status}
                    livePhase={m.livePhase}
                    liveTokens={m.liveTokens}
                    toolCalls={m.toolCalls}
                    toolResults={m.toolResults}
                    artifacts={m.artifacts}
                    appDraftVersions={m.appDraftVersions?.filter((version) =>
                      latestAppDraftIds.has(version.id),
                    )}
                    recommendations={m.recommendations}
                    activityEvents={m.activityEvents}
                    assistantName={user?.assistantName}
                    onOpenArtifact={openArtifactPreview}
                    onDeployAppDraft={handleAppDraftDeploy}
                    onRecommendationAction={handleRecommendationAction}
                    recommendationPendingId={recommendationPendingId}
                    appDraftPendingId={appDraftPendingId}
                    onEdit={
                      m.role === "user" &&
                      !busy &&
                      !activeHasPendingRun &&
                      (!m.hasAttachments ||
                        m.attachmentsReplayable === true) &&
                      m.persisted
                        ? () =>
                            setEditRequest({
                              requestId: crypto.randomUUID(),
                              messageId: m.id,
                              content: stripAttachmentNoteFromMessage(
                                m.content,
                              ),
                              attachmentCount:
                                m.artifacts?.filter(
                                  (artifact) =>
                                    artifact.source === "user-upload",
                                ).length ?? 0,
                            })
                        : undefined
                    }
                  />
                  {m.runId &&
                  (m.canCancel || m.canRetry || m.canResume) ? (
                    <RunControls
                      runId={m.runId}
                      canCancel={m.canCancel}
                      canRetry={m.canRetry}
                      canResume={m.canResume && user?.role === "admin"}
                      pendingAction={runActionPendingId}
                      onAction={runAction}
                    />
                  ) : null}
                  {user?.role === "admin" &&
                  m.role === "assistant" &&
                  m.runId ? (
                    <button
                      type="button"
                      aria-label="Inspect run"
                      title="Inspect run"
                      onClick={() => openRunInspector(m.runId!)}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink"
                    >
                      <RunInspectorIcon />
                    </button>
                  ) : null}
                </div>
              ))
            )}
            {messages.length > 0
              ? (() => {
                  // One orb that lives at the bottom of the thread and moves
                  // down as it grows (Claude-Desktop style) — animating while
                  // the latest turn works, a calm static mark otherwise.
                  const active = messages.find(
                    (m) => m.role === "assistant" && m.pending,
                  );
                  const working = Boolean(active);
                  const len = active?.content.length ?? 0;
                  return (
                    <div className="flex">
                      <ThinkingOrb
                        state={
                          !working
                            ? "idle"
                            : len === 0
                              ? "thinking"
                              : "responding"
                        }
                        energy={len}
                        size={28}
                        stroke={13}
                        className={working ? "text-ink" : "text-muted"}
                      />
                    </div>
                  );
                })()
              : null}
            {error ? (
              <div className="flex flex-col gap-2 rounded-md border border-hairline bg-subtle px-3 py-2 text-sm text-ink sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-2xs font-medium uppercase tracking-wide text-muted">
                    Error
                  </span>
                  <span className="break-words [overflow-wrap:anywhere]">
                    {error}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={retry}
                  disabled={busy || activeHasPendingRun}
                  className="self-start rounded-md border border-hairline bg-canvas px-2.5 py-1 text-xs font-medium text-ink hover:bg-canvas/60 disabled:opacity-50 sm:self-auto"
                >
                  Try again
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div
          data-tour="chat-input"
          className="kb-safe-bottom border-t border-hairline bg-canvas px-3 pt-3 sm:px-6 sm:pt-4"
        >
          <div className="mx-auto max-w-3xl">
            <ChatInput
              key={composerDraftKey ?? "composer-loading"}
              onSubmit={send}
              disabled={inputDisabled}
              skills={slashSkills}
              draftKey={composerDraftKey}
              editRequest={editRequest}
              onEditComplete={() => setEditRequest(undefined)}
              placeholder={
                models.length === 0
                  ? "Loading models…"
                  : busy
                    ? "Generating…"
                    : activeHasPendingRun
                      ? "Run in progress…"
                    : "Ask anything (Shift+Enter for newline)"
              }
            />
          </div>
        </div>
        </section>

        {rightPane?.kind === "inspector" && user?.role === "admin" ? (
          <RunInspectorPane
            runId={rightPane.runId}
            onClose={closeRightPane}
            liveReasoning={inspectedMessage?.providerReasoning}
          />
        ) : rightPane?.kind === "artifact" ? (
          <ArtifactPreviewPane
            artifact={rightPane.artifact}
            onClose={closeRightPane}
          />
        ) : rightPane?.kind === "workspace" ? (
          <SlideOverPane
            ariaLabel="Artifacts"
            defaultWidth={520}
            minWidth={360}
            maxWidth={800}
            onClose={closeRightPane}
            paneTestId="artifacts-pane"
            resizerLabel="Resize artifacts"
            resizerTestId="artifacts-pane-resizer"
            storageKey="comparative.slide-over.artifacts.width"
          >
            <WorkspacePanel
              onClose={closeRightPane}
              onOpenArtifact={openArtifactPreview}
            />
          </SlideOverPane>
        ) : rightPane?.kind === "notifications" ? (
          <SlideOverPane
            ariaLabel="Notifications"
            defaultWidth={440}
            minWidth={360}
            maxWidth={720}
            onClose={closeRightPane}
            paneTestId="notifications-pane"
            resizerLabel="Resize notifications"
            resizerTestId="notifications-pane-resizer"
            storageKey="comparative.slide-over.notifications.width"
          >
            <NotificationsPanel
              onClose={closeRightPane}
              onOpenThread={openThread}
              onUnreadChange={setUnreadNotifications}
            />
          </SlideOverPane>
        ) : null}
      </main>

      {settingsSection ? (
        <SettingsModal
          userEmail={user?.email}
          displayName={user?.displayName ?? ""}
          customInstructions={user?.customInstructions ?? null}
          initialSection={settingsSection}
          onProfileUpdated={handleProfileUpdated}
          models={models}
          defaultModelId={defaultModelId}
          userDefaultModelId={userDefaultModelId}
          onUserDefaultModelChange={updateUserDefaultModel}
          runtimeV2Enabled={runtimeV2Enabled}
          onClose={() => setSettingsSection(null)}
          onReplayTour={() => setWizardOpen(true)}
        />
      ) : null}

      <WelcomeWizard
        open={wizardOpen}
        initialAssistantName={user?.assistantName ?? null}
        connected={oauthConnected}
        onSave={saveWizardStep}
        onComplete={completeWizard}
        onOpenIntegrations={() => {
          setWizardOpen(false);
          setSettingsSection("integrations");
        }}
      />
      <FeedbackReporter
        open={feedbackOpen}
        context={feedbackContext}
        onClose={() => setFeedbackOpen(false)}
      />
    </div>
  );
}

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M8 2.5v6.8" />
      <path d="m5.2 6.8 2.8 2.8 2.8-2.8" />
      <path d="M3 12.5h10" />
    </svg>
  );
}

function RunInspectorIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 4.5h4M8.5 4.5h5M2.5 8h7M11.5 8h2M2.5 11.5h2M6.5 11.5h7" />
      <circle cx="7.5" cy="4.5" r="1" />
      <circle cx="10.5" cy="8" r="1" />
      <circle cx="5.5" cy="11.5" r="1" />
    </svg>
  );
}

function RunControls({
  runId,
  canCancel,
  canRetry,
  canResume,
  pendingAction,
  onAction,
}: {
  runId: string;
  canCancel?: boolean;
  canRetry?: boolean;
  canResume?: boolean;
  pendingAction?: string;
  onAction: (runId: string, action: "cancel" | "retry" | "resume") => void;
}) {
  const pending = pendingAction?.endsWith(`:${runId}`) ?? false;
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {canCancel ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => onAction(runId, "cancel")}
          className="rounded-md border border-hairline bg-canvas px-2.5 py-1 font-medium text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pendingAction === `cancel:${runId}` ? "Canceling..." : "Cancel"}
        </button>
      ) : null}
      {canRetry ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => onAction(runId, "retry")}
          className="rounded-md border border-hairline bg-canvas px-2.5 py-1 font-medium text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pendingAction === `retry:${runId}` ? "Retrying..." : "Retry"}
        </button>
      ) : null}
      {canResume ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => onAction(runId, "resume")}
          className="rounded-md border border-hairline bg-canvas px-2.5 py-1 font-medium text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pendingAction === `resume:${runId}` ? "Resuming..." : "Resume"}
        </button>
      ) : null}
    </div>
  );
}

function EmptyState({
  onPick,
  onOpenIntegrations,
}: {
  onPick: (s: string) => void;
  onOpenIntegrations: () => void;
}) {
  // Sample prompts that work today, not aspirational ones tied to
  // integrations that aren't wired yet. GitHub MCP is the only live tool;
  // the other prompts are pure-model so they work without any connections.
  const samples = [
    "Open GitHub issues assigned to me — what should I tackle first?",
    "Summarize what shipped in my repos this week",
    "Draft a concise project status update for my team",
    "What can you help me with today?",
  ];
  return (
    <div className="flex flex-col items-center gap-4 py-24 text-center">
      <ThinkingOrb
        state="idle"
        size={176}
        stroke={6}
        label="Comparative"
        className="text-ink"
      />
      <div className="font-serif text-2xl font-normal tracking-tight text-ink">
        Talk to your work.
      </div>
      <p className="max-w-md text-sm text-muted">
        GitHub is wired up today. Office 365, Salesforce, and Workfront are
        next — connect what you have in{" "}
        <button
          type="button"
          onClick={onOpenIntegrations}
          className="font-medium text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink"
        >
          Integrations
        </button>
        .
      </p>
      <div className="text-2xs font-medium uppercase tracking-caps text-muted/60">
        {COMPARATIVE_VERSION_LABEL}
      </div>
      <div className="flex flex-wrap justify-center gap-2 pt-4">
        {samples.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-md border border-hairline bg-canvas px-3 py-1.5 text-xs text-muted hover:bg-subtle hover:text-ink"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
