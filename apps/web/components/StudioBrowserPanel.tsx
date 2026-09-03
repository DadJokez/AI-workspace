"use client";

import { Icon } from "@ai-workspace/umber/components/media/Icon";
import dynamic from "next/dynamic";
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { fetchJson } from "@/lib/client-api";
import type { StudioBrowserResource } from "@/lib/contribution-studio";
import {
  studioBrowserTargetKey,
  type StudioBrowserAction,
  type StudioBrowserSessionResponse,
  type StudioBrowserTargetRequest,
} from "@/lib/studio-browser-contract";

const AgentCoreLiveView = dynamic(
  () =>
    import("bedrock-agentcore/browser/live-view").then(
      (module) => module.BrowserLiveView,
    ),
  { ssr: false },
);

const LIVE_VIEW_REFRESH_MARGIN_MS = 15_000;
const LIVE_VIEW_CONNECT_TIMEOUT_MS = 15_000;

interface StudioBrowserPanelProps {
  threadId?: string;
  resources: readonly StudioBrowserResource[];
  requestedTarget?: StudioBrowserTargetRequest;
  onRequestMaximize: () => void;
}

export function StudioBrowserPanel({
  threadId,
  resources,
  requestedTarget,
  onRequestMaximize,
}: StudioBrowserPanelProps) {
  const [session, setSession] = useState<StudioBrowserSessionResponse>();
  const [selected, setSelected] = useState<StudioBrowserResource>();
  const [error, setError] = useState<string>();
  const [actionPending, setActionPending] = useState<StudioBrowserAction>();
  const [liveConnected, setLiveConnected] = useState(false);
  const [liveUnavailable, setLiveUnavailable] = useState(false);
  const [snapshotUrl, setSnapshotUrl] = useState<string>();
  const [snapshotPending, setSnapshotPending] = useState(false);
  const activeSessionId = useRef<string | undefined>(undefined);
  const requestSequence = useRef(0);
  const lastRequestedTarget = useRef<string | undefined>(undefined);
  const teardownTimer = useRef<number | undefined>(undefined);
  const snapshotUrlRef = useRef<string | undefined>(undefined);
  const handleLiveConnected = useCallback(() => setLiveConnected(true), []);
  const handleLiveUnavailable = useCallback(
    () => setLiveUnavailable(true),
    [],
  );

  const resourcesByTarget = useMemo(
    () =>
      new Map(
        resources.map((resource) => [
          studioBrowserTargetKey(resource.target),
          resource,
        ]),
      ),
    [resources],
  );

  const stopSession = useCallback(async (sessionId: string) => {
    await fetch(`/api/studio/browser/sessions/${sessionId}`, {
      method: "DELETE",
      credentials: "include",
      keepalive: true,
    }).catch(() => undefined);
  }, []);

  const clearSnapshot = useCallback(() => {
    setSnapshotUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      snapshotUrlRef.current = undefined;
      return undefined;
    });
  }, []);

  const startTarget = useCallback(
    async (
      target: StudioBrowserTargetRequest,
      resource?: StudioBrowserResource,
    ) => {
      if (!threadId) {
        setError("Save this chat before opening its Browser session.");
        return;
      }
      const sequence = ++requestSequence.current;
      const priorSessionId = activeSessionId.current;
      activeSessionId.current = undefined;
      setSelected(resource);
      setSession(undefined);
      setError(undefined);
      setLiveConnected(false);
      setLiveUnavailable(false);
      clearSnapshot();
      if (priorSessionId) await stopSession(priorSessionId);

      try {
        const body = await fetchJson<{ session: StudioBrowserSessionResponse }>(
          "/api/studio/browser/sessions",
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ threadId, target }),
          },
          "The isolated Browser could not start.",
        );
        if (requestSequence.current !== sequence) {
          await stopSession(body.session.id);
          return;
        }
        activeSessionId.current = body.session.id;
        setSession(body.session);
      } catch (caught) {
        if (requestSequence.current !== sequence) return;
        setError(
          caught instanceof Error
            ? caught.message
            : "The isolated Browser could not start.",
        );
      }
    },
    [clearSnapshot, stopSession, threadId],
  );

  useEffect(() => {
    if (!requestedTarget) return;
    const key = studioBrowserTargetKey(requestedTarget);
    if (lastRequestedTarget.current === key) return;
    lastRequestedTarget.current = key;
    void startTarget(requestedTarget, resourcesByTarget.get(key));
  }, [requestedTarget, resourcesByTarget, startTarget]);

  useEffect(() => {
    if (teardownTimer.current !== undefined) {
      window.clearTimeout(teardownTimer.current);
      teardownTimer.current = undefined;
    }
    return () => {
      teardownTimer.current = window.setTimeout(() => {
        requestSequence.current += 1;
        const sessionId = activeSessionId.current;
        activeSessionId.current = undefined;
        if (sessionId) void stopSession(sessionId);
        if (snapshotUrlRef.current) {
          URL.revokeObjectURL(snapshotUrlRef.current);
          snapshotUrlRef.current = undefined;
        }
      }, 0);
    };
  }, [stopSession]);

  useEffect(() => {
    if (!session?.liveView) return;
    const delay = Math.max(
      1_000,
      new Date(session.liveView.expiresAt).getTime() -
        Date.now() -
        LIVE_VIEW_REFRESH_MARGIN_MS,
    );
    const timeoutId = window.setTimeout(async () => {
      try {
        const body = await fetchJson<{
          liveView: NonNullable<StudioBrowserSessionResponse["liveView"]>;
        }>(
          `/api/studio/browser/sessions/${session.id}/live-view`,
          { method: "POST", credentials: "include" },
          "Browser view expired.",
        );
        setLiveConnected(false);
        setLiveUnavailable(false);
        setSession((current) =>
          current?.id === session.id
            ? { ...current, liveView: body.liveView }
            : current,
        );
      } catch (caught) {
        setLiveUnavailable(true);
        setError(
          caught instanceof Error ? caught.message : "Browser view expired.",
        );
      }
    }, delay);
    return () => window.clearTimeout(timeoutId);
  }, [session?.id, session?.liveView]);

  async function runAction(action: StudioBrowserAction) {
    if (!session || actionPending) return;
    setActionPending(action);
    setError(undefined);
    try {
      await fetchJson<{ ok: true }>(
        `/api/studio/browser/sessions/${session.id}/actions`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
        "Browser action failed.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Browser action failed.",
      );
    } finally {
      setActionPending(undefined);
    }
  }

  async function loadSnapshot() {
    if (!session || snapshotPending) return;
    setSnapshotPending(true);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/studio/browser/sessions/${session.id}/screenshot`,
        { credentials: "include", cache: "no-store" },
      );
      if (!response.ok) throw new Error("Browser snapshot is unavailable.");
      const nextUrl = URL.createObjectURL(await response.blob());
      setSnapshotUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        snapshotUrlRef.current = nextUrl;
        return nextUrl;
      });
      setLiveUnavailable(true);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Browser snapshot is unavailable.",
      );
    } finally {
      setSnapshotPending(false);
    }
  }

  function showTargets() {
    requestSequence.current += 1;
    const sessionId = activeSessionId.current;
    activeSessionId.current = undefined;
    setSession(undefined);
    setSelected(undefined);
    setError(undefined);
    setLiveConnected(false);
    setLiveUnavailable(false);
    clearSnapshot();
    if (sessionId) void stopSession(sessionId);
  }

  if (!session) {
    return (
      <BrowserResourceList
        resources={resources}
        selectedId={selected?.id}
        pending={Boolean(selected) && !error}
        error={error}
        onSelect={(resource) => void startTarget(resource.target, resource)}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="studio-browser">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-hairline px-2">
        <BrowserControl label="Browser targets" onClick={showTargets}>
          <Icon name="globe" size={14} strokeWidth={1.7} />
        </BrowserControl>
        <BrowserControl
          label="Back"
          disabled={Boolean(actionPending)}
          onClick={() => void runAction("back")}
        >
          <Icon name="chevron-left" size={15} strokeWidth={1.7} />
        </BrowserControl>
        <BrowserControl
          label="Forward"
          disabled={Boolean(actionPending)}
          onClick={() => void runAction("forward")}
        >
          <Icon name="chevron-right" size={15} strokeWidth={1.7} />
        </BrowserControl>
        <BrowserControl
          label="Reload"
          disabled={Boolean(actionPending)}
          onClick={() => void runAction("reload")}
        >
          <Icon name="refresh" size={14} strokeWidth={1.7} />
        </BrowserControl>
        <div
          className="mx-1 min-w-0 flex-1 truncate rounded border border-hairline bg-subtle px-2.5 py-1.5 font-mono text-2xs text-muted"
          title={session.displayUrl}
          data-testid="studio-browser-location"
        >
          {session.displayUrl}
        </div>
        <BrowserControl
          label="Copy address"
          onClick={() => void navigator.clipboard.writeText(session.displayUrl)}
        >
          <Icon name="copy" size={14} strokeWidth={1.7} />
        </BrowserControl>
        <BrowserControl label="Maximize Browser" onClick={onRequestMaximize}>
          <Icon name="grid" size={14} strokeWidth={1.7} />
        </BrowserControl>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-subtle">
        {snapshotUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- authenticated object URL
          <img
            src={snapshotUrl}
            alt={`Snapshot of ${selected?.title ?? "Browser target"}`}
            className="h-full w-full object-contain"
            data-testid="studio-browser-snapshot"
          />
        ) : session.liveView && !liveUnavailable ? (
          <LiveViewBoundary
            key={session.liveView.signedUrl}
            onUnavailable={handleLiveUnavailable}
          >
            <BrowserLiveSurface
              key={session.liveView.signedUrl}
              session={session}
              onConnected={handleLiveConnected}
              onUnavailable={handleLiveUnavailable}
            />
          </LiveViewBoundary>
        ) : (
          <BrowserFallback
            title={session.fallback?.title ?? "Live Browser unavailable"}
            detail={
              error ??
              session.fallback?.detail ??
              "The isolated session is not available."
            }
            pending={snapshotPending}
            onSnapshot={() => void loadSnapshot()}
            onRetry={() =>
              selected && void startTarget(selected.target, selected)
            }
          />
        )}

        {!snapshotUrl && session.liveView && !liveConnected && !liveUnavailable ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-canvas/90">
            <span className="text-xs text-muted">Connecting Browser...</span>
          </div>
        ) : null}
      </div>

      {error && !liveUnavailable ? (
        <div className="shrink-0 border-t border-hairline px-3 py-2 text-xs text-danger">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function BrowserLiveSurface({
  session,
  onConnected,
  onUnavailable,
}: {
  session: StudioBrowserSessionResponse;
  onConnected: () => void;
  onUnavailable: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let connected = false;
    const detect = () => {
      if (connected || !root.querySelector('[id^="dcv-display-"]')) return;
      connected = true;
      window.clearTimeout(timeoutId);
      onConnected();
    };
    const observer = new MutationObserver(detect);
    observer.observe(root, { childList: true, subtree: true });
    const timeoutId = window.setTimeout(() => {
      if (!connected) onUnavailable();
    }, LIVE_VIEW_CONNECT_TIMEOUT_MS);
    detect();
    return () => {
      observer.disconnect();
      window.clearTimeout(timeoutId);
    };
  }, [onConnected, onUnavailable]);

  return (
    <div ref={rootRef} className="h-full w-full" data-testid="studio-browser-live-view">
      <AgentCoreLiveView
        signedUrl={session.liveView!.signedUrl}
        remoteWidth={session.viewport.width}
        remoteHeight={session.viewport.height}
      />
    </div>
  );
}

function BrowserResourceList({
  resources,
  selectedId,
  pending,
  error,
  onSelect,
}: {
  resources: readonly StudioBrowserResource[];
  selectedId?: string;
  pending: boolean;
  error?: string;
  onSelect: (resource: StudioBrowserResource) => void;
}) {
  return (
    <div className="h-full overflow-y-auto px-3 py-3 sm:px-4">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-baseline justify-between gap-3 border-b border-hairline pb-3">
          <h3 className="text-sm font-semibold text-ink">Browser targets</h3>
          <span className="font-mono text-2xs text-muted">
            {resources.length} {resources.length === 1 ? "target" : "targets"}
          </span>
        </div>
        {error ? (
          <div
            role="alert"
            className="mt-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
          >
            {error}
          </div>
        ) : null}
        <div className="divide-y divide-hairline">
          {resources.map((resource) => (
            <button
              key={resource.id}
              type="button"
              disabled={pending}
              onClick={() => onSelect(resource)}
              className="flex w-full min-w-0 items-center gap-3 py-3 text-left disabled:cursor-wait disabled:opacity-60"
              data-testid="studio-browser-target"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-subtle text-muted">
                <Icon
                  name={browserResourceIcon(resource.kind)}
                  size={16}
                  strokeWidth={1.6}
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">
                  {resource.title}
                </span>
                <span className="mt-0.5 block truncate text-2xs text-muted">
                  {selectedId === resource.id && pending
                    ? "Starting isolated session..."
                    : resource.detail}
                </span>
              </span>
              <Icon name="chevron-right" size={15} strokeWidth={1.6} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function BrowserFallback({
  title,
  detail,
  pending,
  onSnapshot,
  onRetry,
}: {
  title: string;
  detail: string;
  pending: boolean;
  onSnapshot: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <Icon
          name="alert-triangle"
          size={20}
          strokeWidth={1.5}
          className="mx-auto text-muted"
        />
        <h3 className="mt-3 text-sm font-semibold text-ink">{title}</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted">{detail}</p>
        <div className="mt-4 flex justify-center gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={onSnapshot}
            className="rounded-md border border-hairline bg-canvas px-3 py-1.5 text-xs font-medium text-ink hover:bg-subtle disabled:opacity-60"
          >
            {pending ? "Loading..." : "Show snapshot"}
          </button>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-hairline bg-canvas px-3 py-1.5 text-xs font-medium text-ink hover:bg-subtle"
          >
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}

function BrowserControl({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink disabled:cursor-wait disabled:opacity-50"
    >
      {children}
    </button>
  );
}

class LiveViewBoundary extends Component<
  { children: ReactNode; onUnavailable: () => void },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch() {
    this.props.onUnavailable();
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

function browserResourceIcon(
  kind: StudioBrowserResource["kind"],
): "globe" | "git-branch" | "file-text" | "grid" | "terminal" {
  if (kind === "repo") return "git-branch";
  if (kind === "artifact") return "file-text";
  if (kind === "app") return "grid";
  if (kind === "sandbox") return "terminal";
  return "globe";
}
