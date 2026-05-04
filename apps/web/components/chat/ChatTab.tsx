"use client";

import { ChatInput } from "@/components/ChatInput";
import { MessageBubble } from "@/components/MessageBubble";
import { ModelSelector, type ModelOption } from "@/components/ModelSelector";
import { readSseStream } from "@/lib/sse";
import type { ModelId } from "@ai-workspace/agent";
import { useEffect, useRef, useState } from "react";

interface UiMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  modelId?: string;
  pending?: boolean;
}

interface ChatStreamEvent {
  type:
    | "meta"
    | "text-delta"
    | "tool-call"
    | "tool-result"
    | "usage"
    | "error"
    | "done"
    | "persisted";
  [k: string]: unknown;
}

interface ServerThreadResponse {
  thread: { id: string; title: string | null; defaultModelId: string };
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "tool";
    content: string;
    modelId: string | null;
  }>;
}

interface ChatTabProps {
  /** Existing thread to load, or undefined for a brand-new chat. */
  threadId?: string;
  models: readonly ModelOption[];
  defaultModelId: ModelId;
  visible: boolean;
  /** Called once after the first send creates a new thread server-side. */
  onThreadCreated?: (newThreadId: string) => void;
  /** Called whenever a message is persisted, so the sidebar can re-fetch. */
  onMessagePersisted?: () => void;
}

export function ChatTab({
  threadId,
  models,
  defaultModelId,
  visible,
  onThreadCreated,
  onMessagePersisted,
}: ChatTabProps) {
  const [modelId, setModelId] = useState<ModelId>(defaultModelId);
  const [currentThreadId, setCurrentThreadId] = useState<string | undefined>(
    threadId,
  );
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [loadingHistory, setLoadingHistory] = useState(Boolean(threadId));
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load history when this tab represents an existing thread.
  useEffect(() => {
    if (!threadId) {
      setLoadingHistory(false);
      setMessages([]);
      setCurrentThreadId(undefined);
      return;
    }
    let cancelled = false;
    setLoadingHistory(true);
    fetch(`/api/threads/${threadId}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<ServerThreadResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        setCurrentThreadId(data.thread.id);
        setModelId((data.thread.defaultModelId as ModelId) ?? defaultModelId);
        setMessages(
          data.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            modelId: m.modelId ?? undefined,
          })),
        );
        setLoadingHistory(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(`Failed to load thread: ${String(e)}`);
        setLoadingHistory(false);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, defaultModelId]);

  useEffect(() => {
    if (!visible) return;
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, visible]);

  async function send(text: string) {
    if (busy) return;
    setError(undefined);
    setBusy(true);

    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", content: text },
      { id: assistantId, role: "assistant", content: "", pending: true },
    ]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          threadId: currentThreadId,
          modelId,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }

      let assistantText = "";
      let assistantModel: string | undefined;
      let createdThreadId: string | undefined;

      for await (const ev of readSseStream<ChatStreamEvent>(res)) {
        if (ev.type === "meta") {
          if (typeof ev.threadId === "string") {
            if (!currentThreadId) {
              createdThreadId = ev.threadId;
              setCurrentThreadId(ev.threadId);
            }
          }
          if (typeof ev.modelId === "string") assistantModel = ev.modelId;
        } else if (ev.type === "text-delta" && typeof ev.delta === "string") {
          assistantText += ev.delta;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: assistantText,
                    pending: true,
                    modelId: assistantModel,
                  }
                : m,
            ),
          );
        } else if (ev.type === "error" && typeof ev.message === "string") {
          throw new Error(ev.message);
        } else if (ev.type === "persisted") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, pending: false, modelId: assistantModel }
                : m,
            ),
          );
        }
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, pending: false } : m,
        ),
      );

      if (createdThreadId && onThreadCreated) {
        onThreadCreated(createdThreadId);
      }
      onMessagePersisted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: m.content || "(error)", pending: false }
            : m,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`flex h-full flex-col ${visible ? "" : "hidden"}`}
      aria-hidden={!visible}
    >
      <div className="flex h-10 shrink-0 items-center justify-end border-b border-zinc-200/60 px-4 dark:border-zinc-800/60">
        {models.length > 0 ? (
          <ModelSelector
            value={modelId}
            onChange={setModelId}
            options={models}
            disabled={busy}
          />
        ) : null}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-8">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {loadingHistory ? (
            <div className="text-sm text-zinc-400 dark:text-zinc-500">
              Loading thread…
            </div>
          ) : messages.length === 0 ? (
            <EmptyState onPick={send} />
          ) : (
            messages.map((m) => (
              <MessageBubble
                key={m.id}
                role={m.role}
                content={m.content}
                modelId={m.modelId}
                pending={m.pending}
              />
            ))
          )}
          {error ? (
            <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
              {error}
            </div>
          ) : null}
        </div>
      </div>

      <div className="border-t border-zinc-200/60 px-6 py-4 dark:border-zinc-800/60">
        <div className="mx-auto max-w-2xl">
          <ChatInput
            onSubmit={send}
            disabled={busy || models.length === 0 || loadingHistory}
            placeholder={
              models.length === 0
                ? "Loading models…"
                : busy
                  ? "Generating…"
                  : "Ask anything (Shift+Enter for newline)"
            }
          />
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (s: string) => void }) {
  const samples = [
    "Summarize what's on my calendar tomorrow",
    "Draft a quick reply to the most recent email from finance",
    "What are my unread Slack mentions today?",
  ];
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <div className="text-2xl font-medium tracking-tight text-zinc-900 dark:text-zinc-100">
        Talk to your work
      </div>
      <p className="max-w-md text-sm text-zinc-500 dark:text-zinc-500">
        Ask anything. Pick the model that fits the job — Haiku for fast, Sonnet
        for default, Opus for hard.
      </p>
      <div className="flex flex-wrap justify-center gap-2 pt-4">
        {samples.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
