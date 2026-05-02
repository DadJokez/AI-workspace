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

interface ModelsResponse {
  defaultModelId: ModelId;
  models: ModelOption[];
}

export function ChatClient() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelId, setModelId] = useState<ModelId>("sonnet-4-6");
  const [threadId, setThreadId] = useState<string | undefined>();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json() as Promise<ModelsResponse>)
      .then((data) => {
        setModels(data.models);
        setModelId(data.defaultModelId);
      })
      .catch((e) => setError(`failed to load models: ${String(e)}`));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

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
        body: JSON.stringify({ message: text, threadId, modelId }),
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

      for await (const ev of readSseStream<ChatStreamEvent>(res)) {
        if (ev.type === "meta") {
          if (typeof ev.threadId === "string") setThreadId(ev.threadId);
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
        } else if (ev.type === "done") {
          // wait for `persisted` to drop pending
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

      // If the stream ended without a `persisted` event, still drop the pending flag.
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, pending: false } : m,
        ),
      );
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

  function newChat() {
    setThreadId(undefined);
    setMessages([]);
    setError(undefined);
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white/80 px-4 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold tracking-tight">AI Hub</h1>
          <button
            type="button"
            onClick={newChat}
            disabled={busy}
            className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            New chat
          </button>
        </div>
        {models.length > 0 ? (
          <ModelSelector
            value={modelId}
            onChange={setModelId}
            options={models}
            disabled={busy}
          />
        ) : null}
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {messages.length === 0 ? (
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
            <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
              {error}
            </div>
          ) : null}
        </div>
      </div>

      <div className="border-t border-zinc-200 bg-white/80 px-4 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mx-auto max-w-2xl">
          <ChatInput
            onSubmit={send}
            disabled={busy || models.length === 0}
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
      <div className="text-2xl font-semibold tracking-tight">
        Talk to your work
      </div>
      <p className="max-w-md text-sm text-zinc-500 dark:text-zinc-400">
        Ask anything. Pick the model that fits the job — Haiku for fast, Sonnet
        for default, Opus for hard. Tools land later this week.
      </p>
      <div className="flex flex-wrap justify-center gap-2 pt-4">
        {samples.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
