"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import Link from "next/link";
import {
  MAX_ATTACHMENTS,
  isSupportedAttachmentName,
  type ChatAttachment,
} from "@/lib/attachments";
import { useDictation } from "@/lib/use-dictation";
import {
  filterSkillsForCommand,
  isSlashCommand,
  type SlashSkillCandidate,
} from "@/lib/skill-commands";

const MAX_HEIGHT_PX = 200;

export interface SlashSkill extends SlashSkillCandidate {
  isStarter?: boolean;
  sharedWithMe?: boolean;
}

interface Props {
  onSubmit: (text: string, attachments?: ChatAttachment[]) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Runnable skills for the "/" palette. Empty/undefined = palette off. */
  skills?: SlashSkill[];
  /**
   * Run a skill from the palette. Resolves to null on success (the caller
   * navigates to the run's thread) or a user-facing error message.
   */
  onRunSkill?: (skill: SlashSkill) => Promise<string | null>;
}

/**
 * Chat input with a slash-command palette (#144): type "/" to pick from
 * your skills — the Claude-Desktop-style affordance where the input box is
 * the command surface. A submitted "/…" line never reaches the model: it
 * either runs the single matching skill or explains itself, killing the
 * hallucinated-command failure mode at the source.
 */
export function ChatInput({
  onSubmit,
  disabled,
  placeholder = "Ask anything — or type / to run a skill…",
  skills = [],
  onRunSkill,
}: Props) {
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [launching, setLaunching] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dictation = useDictation((spoken) => {
    setText((prev) => {
      const sep = prev && !prev.endsWith(" ") ? " " : "";
      return `${prev}${sep}${spoken.trim()}`;
    });
  });

  const paletteActive =
    isSlashCommand(text) && skills.length > 0 && !!onRunSkill && !launching;
  const matches = useMemo(
    () => (paletteActive ? filterSkillsForCommand(text, skills) : []),
    [paletteActive, text, skills],
  );

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const next = Math.min(ta.scrollHeight, MAX_HEIGHT_PX);
    ta.style.height = `${next}px`;
    ta.style.overflowY = ta.scrollHeight > MAX_HEIGHT_PX ? "auto" : "hidden";
  }, [text]);

  // Keep the highlighted row valid as the filter narrows.
  useEffect(() => {
    if (highlight >= matches.length) setHighlight(0);
  }, [matches.length, highlight]);

  async function runSkill(skill: SlashSkill) {
    if (!onRunSkill || launching) return;
    setLaunching(skill.name);
    setNotice(null);
    try {
      const error = await onRunSkill(skill);
      if (error) {
        setNotice(error);
      } else {
        setText("");
      }
    } catch {
      setNotice(`Could not start "${skill.name}". Try again.`);
    } finally {
      setLaunching(null);
    }
  }

  async function addFiles(files: FileList | File[]) {
    const incoming = Array.from(files);
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setNotice(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      return;
    }
    const next: ChatAttachment[] = [];
    for (const file of incoming.slice(0, room)) {
      if (!isSupportedAttachmentName(file.name)) {
        setNotice(`"${file.name}" isn't a supported text file yet.`);
        continue;
      }
      try {
        const content = await file.text();
        next.push({ name: file.name, content });
      } catch {
        setNotice(`Could not read "${file.name}".`);
      }
    }
    if (next.length > 0) {
      setAttachments((prev) => [...prev, ...next]);
      setNotice(null);
    }
  }

  function removeAttachment(name: string) {
    setAttachments((prev) => prev.filter((a) => a.name !== name));
  }

  function send() {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || disabled) return;

    // Slash lines are commands, never chat. Run the obvious match or explain.
    if (isSlashCommand(trimmed) && onRunSkill) {
      if (matches.length >= 1) {
        void runSkill(matches[Math.min(highlight, matches.length - 1)]!);
      } else {
        setNotice(
          skills.length > 0
            ? "No skill matches that — keep typing to filter, or browse Skills in the sidebar."
            : "Slash commands run your skills, but none are available yet — open Skills in the sidebar to create or seed some.",
        );
      }
      return;
    }

    onSubmit(trimmed, attachments.length > 0 ? attachments : undefined);
    setText("");
    setAttachments([]);
    setNotice(null);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    send();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (paletteActive && matches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => (h + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setText("");
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        void runSkill(matches[Math.min(highlight, matches.length - 1)]!);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="relative w-full">
      {paletteActive ? (
        <div className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-lg border border-hairline bg-canvas shadow-xl">
          <p className="border-b border-hairline px-3 py-1.5 text-[11px] uppercase tracking-wider text-muted">
            Run a skill
          </p>
          {matches.length === 0 ? (
            <p className="px-3 py-3 text-[13px] text-muted">
              Nothing matches. Browse{" "}
              <Link href="/skills" className="text-ink underline">
                Skills
              </Link>{" "}
              to see what&apos;s available.
            </p>
          ) : (
            <ul className="max-h-64 overflow-y-auto py-1">
              {matches.map((skill, index) => (
                <li key={skill.id}>
                  <button
                    type="button"
                    onMouseEnter={() => setHighlight(index)}
                    onClick={() => void runSkill(skill)}
                    className={`flex w-full items-baseline gap-2 px-3 py-2 text-left ${
                      index === highlight ? "bg-subtle" : ""
                    }`}
                  >
                    <span className="shrink-0 text-[13px] font-medium text-ink">
                      {skill.name}
                    </span>
                    {skill.mcpProviders.length > 0 ? (
                      <span className="shrink-0 rounded bg-ink/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                        {skill.mcpProviders.join(" · ")}
                      </span>
                    ) : null}
                    <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
                      {skill.description}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-hairline px-3 py-1.5 text-[11px] text-muted">
            ↑↓ choose · Enter run · Esc dismiss
          </p>
        </div>
      ) : null}

      {dictation.listening ? (
        <p className="mb-1.5 flex items-center gap-2 px-1 text-[12px] text-red-500/80">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
          Listening… {dictation.interim ? `“${dictation.interim}”` : "speak now"}
        </p>
      ) : null}
      {launching ? (
        <p className="mb-1.5 flex items-center gap-2 px-1 text-[12px] text-muted">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
          Starting {launching}…
        </p>
      ) : notice ? (
        <p className="mb-1.5 px-1 text-[12px] text-muted">{notice}</p>
      ) : null}

      {attachments.length > 0 ? (
        <div className="mb-1.5 flex flex-wrap gap-1.5 px-1">
          {attachments.map((a) => (
            <span
              key={a.name}
              className="flex items-center gap-1.5 rounded-md border border-hairline bg-subtle px-2 py-1 text-[12px] text-ink"
            >
              <PaperclipIcon />
              <span className="max-w-[160px] truncate">{a.name}</span>
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                onClick={() => removeAttachment(a.name)}
                className="text-muted hover:text-ink"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <form
        onSubmit={handleSubmit}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length > 0) void addFiles(e.dataTransfer.files);
        }}
        className={`flex w-full items-end gap-2 rounded-lg border bg-canvas p-2 ${
          dragOver
            ? "border-ink/60 ring-1 ring-ink/30"
            : "border-hairline focus-within:border-ink/40"
        }`}
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          aria-label="Attach files"
          disabled={disabled || launching !== null}
          onClick={() => fileRef.current?.click()}
          className="flex h-11 w-9 shrink-0 items-center justify-center rounded-md text-muted hover:text-ink disabled:opacity-30 sm:h-7"
        >
          <PaperclipIcon />
        </button>
        {dictation.supported ? (
          <button
            type="button"
            aria-label={dictation.listening ? "Stop dictation" : "Dictate"}
            aria-pressed={dictation.listening}
            title={dictation.listening ? "Stop dictation" : "Dictate"}
            disabled={disabled || launching !== null}
            onClick={dictation.toggle}
            className={`flex h-11 w-9 shrink-0 items-center justify-center rounded-md disabled:opacity-30 sm:h-7 ${
              dictation.listening
                ? "text-red-500"
                : "text-muted hover:text-ink"
            }`}
          >
            <MicIcon listening={dictation.listening} />
          </button>
        ) : null}
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (notice) setNotice(null);
          }}
          onKeyDown={handleKeyDown}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length > 0) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          rows={1}
          placeholder={dragOver ? "Drop files to attach…" : placeholder}
          disabled={disabled || launching !== null}
          // Inline font-size beats every class-level rule. Sub-16px lets
          // iOS Safari (and Comet, which inherits the WebKit zoom rule) zoom
          // the page on focus. Belt-and-suspenders with `text-base`.
          style={{ fontSize: "16px" }}
          className="flex-1 resize-none bg-transparent px-2 py-2 text-base text-ink outline-none placeholder:text-muted disabled:opacity-50 sm:py-1.5"
        />
        <button
          type="submit"
          disabled={
            disabled ||
            launching !== null ||
            (!text.trim() && attachments.length === 0)
          }
          aria-label="Send"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-ink text-canvas disabled:opacity-30 sm:h-7 sm:w-7"
        >
          <svg
            viewBox="0 0 16 16"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
          </svg>
        </button>
      </form>
    </div>
  );
}

function MicIcon({ listening }: { listening: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill={listening ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="6" y="1.5" width="4" height="8" rx="2" />
      <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5" />
    </svg>
  );
}

function PaperclipIcon() {
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
      <path d="M13 7.5 8 12.5a3 3 0 0 1-4.2-4.2l5.5-5.5a2 2 0 0 1 2.8 2.8L6.6 11" />
    </svg>
  );
}
