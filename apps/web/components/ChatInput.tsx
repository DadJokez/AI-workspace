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
  MAX_ATTACHMENT_BYTES,
  isSupportedAttachmentName,
  mimeTypeForAttachmentName,
  unsupportedAttachmentMessage,
  type ChatAttachment,
} from "@/lib/attachments";
import { useDictation } from "@/lib/use-dictation";
import {
  buildActivatedSlashSkill,
  buildSlashSkillDisplayMessage,
  filterSkillsForCommand,
  isSlashCommand,
  resolveSlashSkillActivation,
  slashArgumentsForSkill,
  slashSkillToken,
  type ActivatedSlashSkill,
  type SlashSkillCandidate,
} from "@/lib/skill-commands";
import {
  buildModelCommandDisplayMessage,
  isModelCommandInput,
  modelCommandUsageMessage,
  parseModelCommand,
  type ChatModelOverride,
} from "@/lib/model-command";

const MAX_HEIGHT_PX = 200;
const DRAFT_STORAGE_PREFIX = "comparative-chat-draft:";
const DRAFT_PERSIST_DELAY_MS = 250;

function persistComposerDraft(storageKey: string | null, text: string) {
  if (!storageKey) return;
  try {
    if (text) {
      window.localStorage.setItem(storageKey, text);
    } else {
      window.localStorage.removeItem(storageKey);
    }
  } catch {
    // Draft recovery is best-effort and must never block the composer.
  }
}

export interface SlashSkill extends SlashSkillCandidate {
  isStarter?: boolean;
  sharedWithMe?: boolean;
}

export interface ChatEditRequest {
  requestId: string;
  messageId: string;
  content: string;
  /**
   * User-upload count on the message being edited (#348). Those files
   * replay from storage on resend; while editing such a turn, adding NEW
   * files is blocked (the server rejects the mix as
   * `attachments_conflict_with_replay`).
   */
  attachmentCount?: number;
}

interface Props {
  onSubmit: (
    text: string,
    attachments?: ChatAttachment[],
    activatedSkill?: ActivatedSlashSkill,
    modelOverride?: ChatModelOverride,
    replaceMessageId?: string,
  ) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Runnable skills for the "/" palette. Empty/undefined = palette off. */
  skills?: SlashSkill[];
  /** Stable, user-scoped conversation key used for local draft recovery. */
  draftKey?: string;
  editRequest?: ChatEditRequest;
  onEditComplete?: () => void;
}

/**
 * Chat input with a slash-command palette (#144): type "/" to pick from
 * available capabilities. For phase 1, capabilities are skills. Selecting a
 * skill activates hidden context for the next normal chat turn instead of
 * opening a separate skill-run thread.
 */
export function ChatInput({
  onSubmit,
  disabled,
  placeholder = "Ask anything — or type / for capabilities…",
  skills = [],
  draftKey,
  editRequest,
  onEditComplete,
}: Props) {
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [activeSkill, setActiveSkill] = useState<SlashSkill | null>(null);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [uploadReady, setUploadReady] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const draftTimerRef = useRef<number | undefined>(undefined);
  const skipNextDraftPersistRef = useRef(true);
  const handledEditRequestRef = useRef<string | undefined>(undefined);
  const editBackupRef = useRef<{
    text: string;
    attachments: ChatAttachment[];
    activeSkill: SlashSkill | null;
  } | null>(null);
  const draftStorageKey = draftKey
    ? `${DRAFT_STORAGE_PREFIX}${draftKey}`
    : null;
  const draftTextForStorage = editRequest
    ? (editBackupRef.current?.text ?? text)
    : text;
  const latestDraftRef = useRef({
    storageKey: draftStorageKey,
    text: draftTextForStorage,
  });
  latestDraftRef.current = {
    storageKey: draftStorageKey,
    text: draftTextForStorage,
  };
  const dictation = useDictation((spoken) => {
    setText((prev) => {
      const sep = prev && !prev.endsWith(" ") ? " " : "";
      return `${prev}${sep}${spoken.trim()}`;
    });
  });

  useEffect(() => {
    setUploadReady(true);
  }, []);

  const paletteActive =
    isSlashCommand(text) &&
    !isModelCommandInput(text) &&
    skills.length > 0 &&
    activeSkill === null;
  const matches = useMemo(
    () => (paletteActive ? filterSkillsForCommand(text, skills) : []),
    [paletteActive, text, skills],
  );

  useEffect(() => {
    skipNextDraftPersistRef.current = true;
    if (draftTimerRef.current !== undefined) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = undefined;
    }
    if (!draftStorageKey) return;
    try {
      const restored = window.localStorage.getItem(draftStorageKey) ?? "";
      latestDraftRef.current = { storageKey: draftStorageKey, text: restored };
      setText(restored);
    } catch {
      // Storage may be unavailable in private or locked-down browsers.
    }
  }, [draftStorageKey]);

  useEffect(() => {
    if (
      !editRequest ||
      handledEditRequestRef.current === editRequest.requestId
    ) {
      return;
    }
    if (!editBackupRef.current) {
      editBackupRef.current = { text, attachments, activeSkill };
    }
    persistComposerDraft(draftStorageKey, text);
    latestDraftRef.current = { storageKey: draftStorageKey, text };
    handledEditRequestRef.current = editRequest.requestId;
    setText(editRequest.content);
    setAttachments([]);
    setActiveSkill(null);
    setNotice(null);
    window.setTimeout(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(
        editRequest.content.length,
        editRequest.content.length,
      );
    }, 0);
  }, [activeSkill, attachments, draftStorageKey, editRequest, text]);

  useEffect(() => {
    if (skipNextDraftPersistRef.current) {
      skipNextDraftPersistRef.current = false;
      return;
    }
    if (editRequest) return;
    if (!draftStorageKey) return;

    draftTimerRef.current = window.setTimeout(() => {
      persistComposerDraft(draftStorageKey, text);
      draftTimerRef.current = undefined;
    }, DRAFT_PERSIST_DELAY_MS);

    return () => {
      if (draftTimerRef.current !== undefined) {
        window.clearTimeout(draftTimerRef.current);
        draftTimerRef.current = undefined;
      }
    };
  }, [draftStorageKey, editRequest, text]);

  useEffect(() => {
    function flushLatestDraft() {
      if (draftTimerRef.current !== undefined) {
        window.clearTimeout(draftTimerRef.current);
        draftTimerRef.current = undefined;
      }
      persistComposerDraft(
        latestDraftRef.current.storageKey,
        latestDraftRef.current.text,
      );
    }

    window.addEventListener("pagehide", flushLatestDraft);
    return () => {
      window.removeEventListener("pagehide", flushLatestDraft);
      flushLatestDraft();
    };
  }, []);

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

  function activateSkill(skill: SlashSkill) {
    const args = slashArgumentsForSkill(text, skill);
    setActiveSkill(skill);
    setText(args);
    setNotice(null);
    window.setTimeout(() => taRef.current?.focus(), 0);
  }

  async function addFiles(files: FileList | File[]) {
    if (editRequest?.attachmentCount) {
      setNotice(
        "This message re-sends its original files when edited — new files can't be added here. Send them in a new message.",
      );
      return;
    }
    const incoming = Array.from(files);
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setNotice(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      return;
    }
    const next: ChatAttachment[] = [];
    for (const file of incoming.slice(0, room)) {
      if (!isSupportedAttachmentName(file.name)) {
        setNotice(unsupportedAttachmentMessage(file.name));
        continue;
      }
      // #430: reject oversize at attach time — a too-big file must never
      // reach send, where a phantom "file attached" note could outlive it.
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setNotice(
          `"${file.name}" is ${formatBytes(file.size)} — the limit is ${formatBytes(MAX_ATTACHMENT_BYTES)} per file. Compress or resize it and try again.`,
        );
        continue;
      }
      try {
        const dataBase64 = await readFileAsBase64(file);
        next.push({
          name: file.name,
          mimeType: file.type || mimeTypeForAttachmentName(file.name),
          sizeBytes: file.size,
          dataBase64,
        });
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

  function clearPersistedDraft() {
    if (draftTimerRef.current !== undefined) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = undefined;
    }
    latestDraftRef.current = { storageKey: draftStorageKey, text: "" };
    persistComposerDraft(draftStorageKey, "");
  }

  function completeSubmission() {
    clearPersistedDraft();
    latestDraftRef.current = { storageKey: draftStorageKey, text: "" };
    editBackupRef.current = null;
    handledEditRequestRef.current = undefined;
    setText("");
    setActiveSkill(null);
    setAttachments([]);
    setNotice(null);
    onEditComplete?.();
  }

  function cancelEdit() {
    const backup = editBackupRef.current;
    editBackupRef.current = null;
    handledEditRequestRef.current = undefined;
    setText(backup?.text ?? "");
    setAttachments(backup?.attachments ?? []);
    setActiveSkill(backup?.activeSkill ?? null);
    setNotice(null);
    onEditComplete?.();
    window.setTimeout(() => taRef.current?.focus(), 0);
  }

  function send() {
    const trimmed = text.trim();
    if (
      (!trimmed && attachments.length === 0 && activeSkill === null) ||
      disabled
    ) {
      return;
    }

    if (activeSkill) {
      onSubmit(
        buildSlashSkillDisplayMessage(activeSkill, trimmed),
        attachments.length > 0 ? attachments : undefined,
        buildActivatedSlashSkill(activeSkill, trimmed),
        undefined,
        editRequest?.messageId,
      );
      completeSubmission();
      return;
    }

    if (isModelCommandInput(trimmed)) {
      const parsed = parseModelCommand(trimmed);
      if (!parsed) {
        setNotice(modelCommandUsageMessage());
        return;
      }
      if (!parsed.body.trim() && attachments.length === 0) {
        setNotice(modelCommandUsageMessage());
        return;
      }
      onSubmit(
        buildModelCommandDisplayMessage(parsed.override, parsed.body),
        attachments.length > 0 ? attachments : undefined,
        undefined,
        parsed.override,
        editRequest?.messageId,
      );
      completeSubmission();
      return;
    }

    // A slash line is a capability activation. Send it as a normal chat turn
    // only when the input resolves clearly to one skill; otherwise keep the
    // model from seeing a stray command-shaped prompt.
    if (isSlashCommand(trimmed)) {
      const resolved = resolveSlashSkillActivation(trimmed, skills);
      if (!resolved) {
        setNotice(
          skills.length > 0
            ? "No skill matches that — keep typing to filter, or browse Skills in the sidebar."
            : "No slash capabilities are available yet — open Skills in the sidebar to create or seed some.",
        );
        return;
      }
      onSubmit(
        buildSlashSkillDisplayMessage(resolved.skill, resolved.args),
        attachments.length > 0 ? attachments : undefined,
        buildActivatedSlashSkill(resolved.skill, resolved.args),
        undefined,
        editRequest?.messageId,
      );
      completeSubmission();
      return;
    }

    onSubmit(
      trimmed,
      attachments.length > 0 ? attachments : undefined,
      undefined,
      undefined,
      editRequest?.messageId,
    );
    completeSubmission();
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
        if (activeSkill) {
          setActiveSkill(null);
        } else {
          setText("");
        }
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        activateSkill(matches[Math.min(highlight, matches.length - 1)]!);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        activateSkill(matches[Math.min(highlight, matches.length - 1)]!);
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
            Capabilities
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
                    onClick={() => activateSkill(skill)}
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
            ↑↓ choose · Enter select · Tab select · Esc dismiss
          </p>
        </div>
      ) : null}

      {dictation.listening ? (
        <p className="mb-1.5 flex items-center gap-2 px-1 text-[12px] text-danger/80">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
          Listening… {dictation.interim ? `“${dictation.interim}”` : "speak now"}
        </p>
      ) : null}
      {editRequest ? (
        <div
          data-testid="edit-message-state"
          className="mb-1.5 flex items-center justify-between gap-2 px-1 text-[12px] text-muted"
        >
          <span>
            Editing message
            {editRequest.attachmentCount ? (
              <span data-testid="edit-replay-note">
                {` — ${editRequest.attachmentCount} uploaded file${editRequest.attachmentCount === 1 ? "" : "s"} will be re-sent unchanged`}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            aria-label="Cancel editing message"
            title="Cancel edit"
            onClick={cancelEdit}
            className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-subtle hover:text-ink"
          >
            ×
          </button>
        </div>
      ) : null}
      {activeSkill ? (
        <div className="mb-1.5 flex flex-wrap items-center gap-2 px-1 text-[12px] text-[#b9d2ff]">
          <span
            data-testid="active-slash-skill"
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[#2f6bff]/50 bg-[#06112f]/80 px-2 py-1 shadow-[0_0_16px_rgba(0,92,255,0.22)] umber:border-hairline umber:bg-subtle umber:text-ink umber:shadow-none"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[#28d7ff] shadow-[0_0_12px_rgba(40,215,255,0.8)] umber:bg-pop umber:shadow-none" />
            <span className="font-mono">{slashSkillToken(activeSkill)}</span>
            <span className="text-[#88a8e8] umber:text-muted">
              {activeSkill.name}
            </span>
            <button
              type="button"
              aria-label={`Remove ${activeSkill.name}`}
              onClick={() => setActiveSkill(null)}
              className="ml-0.5 text-[#88a8e8] hover:text-white umber:text-muted umber:hover:text-ink"
            >
              ×
            </button>
          </span>
          <span className="text-muted">Active for this message</span>
        </div>
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
              {typeof a.sizeBytes === "number" ? (
                <span className="text-muted">{formatBytes(a.sizeBytes)}</span>
              ) : null}
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
          data-testid="chat-file-input"
          type="file"
          multiple
          disabled={disabled || !uploadReady}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          aria-label="Attach files"
          disabled={disabled || !uploadReady}
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
            disabled={disabled}
            onClick={dictation.toggle}
            className={`flex h-11 w-9 shrink-0 items-center justify-center rounded-md disabled:opacity-30 sm:h-7 ${
              dictation.listening
                ? "text-danger"
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
          disabled={disabled}
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
            (!text.trim() && attachments.length === 0 && activeSkill === null)
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

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.includes(",") ? result.split(",").pop() ?? "" : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
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
