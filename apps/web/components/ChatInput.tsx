"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";

interface Props {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function ChatInput({
  onSubmit,
  disabled,
  placeholder = "Ask anything…",
}: Props) {
  const [text, setText] = useState("");

  function send() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setText("");
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    send();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex w-full items-end gap-2 rounded-2xl border border-zinc-300 bg-white p-2 focus-within:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:focus-within:border-zinc-400"
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={1}
        placeholder={placeholder}
        disabled={disabled}
        className="min-h-[2.25rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-zinc-400 disabled:opacity-50 dark:placeholder:text-zinc-500"
      />
      <button
        type="submit"
        disabled={disabled || !text.trim()}
        className="rounded-xl bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-zinc-900"
      >
        Send
      </button>
    </form>
  );
}
