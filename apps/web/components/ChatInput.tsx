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
  MAX_RUNTIME_IMAGE_BYTES,
  attachmentKindForName,
  dedupeChatAttachments,
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
import {
  MAX_CONTEXT_RESOURCE_REFERENCES,
  contextResourceReferenceKey,
  contextResourceSearchResultsFromManifest,
  contextResourceSelectionsForPersistence,
  parseContextResourceSearchResponse,
  type ContextResourceManifest,
  type ContextResourceReference,
  type ContextResourceSearchResult,
} from "@/lib/context-shelf";

const MAX_HEIGHT_PX = 200;
const DRAFT_STORAGE_PREFIX = "comparative-chat-draft:";
const CONTEXT_DRAFT_STORAGE_PREFIX = "comparative-chat-draft-context:v1:";
const DRAFT_PERSIST_DELAY_MS = 250;
const CONTEXT_SEARCH_DELAY_MS = 180;

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

function persistContextDraft(
  storageKey: string | null,
  resources: readonly ContextResourceSearchResult[],
) {
  if (!storageKey) return;
  try {
    if (resources.length > 0) {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify(contextResourceSelectionsForPersistence(resources)),
      );
    } else {
      window.localStorage.removeItem(storageKey);
    }
  } catch {
    // Context draft recovery is best-effort, like the text draft.
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
  contextResourceReferences?: ContextResourceReference[];
  contextResourceManifest?: ContextResourceManifest;
}

interface Props {
  onSubmit: (
    text: string,
    attachments?: ChatAttachment[],
    activatedSkill?: ActivatedSlashSkill,
    modelOverride?: ChatModelOverride,
    replaceMessageId?: string,
    contextResources?: ContextResourceSearchResult[],
  ) => boolean | void;
  disabled?: boolean;
  /** Hold submission while profile-backed draft state is still hydrating. */
  submitDisabled?: boolean;
  /** Current work is active, so accepted text becomes a browser-local follow-up. */
  queueMode?: boolean;
  placeholder?: string;
  /** Runnable skills for the "/" palette. Empty/undefined = palette off. */
  skills?: SlashSkill[];
  /** Stable, user-scoped conversation key used for local draft recovery. */
  draftKey?: string;
  threadId?: string;
  /** Explicitly starting a new chat clears the shared unsent-chat draft. */
  restoreDraft?: boolean;
  editRequest?: ChatEditRequest;
  onEditComplete?: () => void;
  /** Incremented by global actions that should open the native file picker. */
  uploadRequestId?: number;
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
  submitDisabled = false,
  queueMode = false,
  placeholder = "Ask anything — / for skills, @ to add context",
  skills = [],
  draftKey,
  threadId,
  restoreDraft = true,
  editRequest,
  onEditComplete,
  uploadRequestId = 0,
}: Props) {
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [activeSkill, setActiveSkill] = useState<SlashSkill | null>(null);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [contextResources, setContextResources] = useState<
    ContextResourceSearchResult[]
  >([]);
  const [contextScope, setContextScope] = useState<"workspace" | "google_mail">(
    "workspace",
  );
  const [contextResults, setContextResults] = useState<
    ContextResourceSearchResult[]
  >([]);
  const [contextScopes, setContextScopes] = useState<
    NonNullable<ReturnType<typeof parseContextResourceSearchResponse>>["scopes"]
  >([]);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [contextHighlight, setContextHighlight] = useState(0);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [uploadReady, setUploadReady] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const handledUploadRequestIdRef = useRef(0);
  const draftTimerRef = useRef<number | undefined>(undefined);
  const skipNextDraftPersistRef = useRef(true);
  const skipNextContextDraftPersistRef = useRef(true);
  const hydratedDraftStorageKeyRef = useRef<string | null>(null);
  const handledEditRequestRef = useRef<string | undefined>(undefined);
  const editBackupRef = useRef<{
    text: string;
    attachments: ChatAttachment[];
    activeSkill: SlashSkill | null;
    contextResources: ContextResourceSearchResult[];
  } | null>(null);
  const draftStorageKey = draftKey
    ? `${DRAFT_STORAGE_PREFIX}${draftKey}`
    : null;
  const contextDraftStorageKey = draftKey
    ? `${CONTEXT_DRAFT_STORAGE_PREFIX}${draftKey}`
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

  useEffect(() => {
    if (
      uploadRequestId <= 0 ||
      uploadRequestId === handledUploadRequestIdRef.current ||
      !uploadReady ||
      disabled ||
      queueMode
    ) {
      return;
    }
    handledUploadRequestIdRef.current = uploadRequestId;
    fileRef.current?.click();
  }, [disabled, queueMode, uploadReady, uploadRequestId]);

  const paletteActive =
    isSlashCommand(text) &&
    !isModelCommandInput(text) &&
    skills.length > 0 &&
    activeSkill === null;
  const matches = useMemo(
    () => (paletteActive ? filterSkillsForCommand(text, skills) : []),
    [paletteActive, text, skills],
  );
  const contextToken = useMemo(
    () => findContextToken(text, cursorPosition),
    [cursorPosition, text],
  );
  const contextPaletteActive =
    contextToken !== null && !paletteActive && !isModelCommandInput(text);
  const visibleContextResults = useMemo(() => {
    const selected = new Set(
      contextResources.map((resource) =>
        contextResourceReferenceKey(resource.reference),
      ),
    );
    return contextResults.filter(
      (resource) => !selected.has(contextResourceReferenceKey(resource.reference)),
    );
  }, [contextResources, contextResults]);

  useEffect(() => {
    if (!contextPaletteActive || !contextToken) {
      setContextScope("workspace");
      setContextResults([]);
      setContextError(null);
      setContextLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({
        q: contextToken.query,
        scope: contextScope,
        ...(threadId ? { threadId } : {}),
      });
      setContextLoading(true);
      setContextError(null);
      void fetch(`/api/context/resources?${params.toString()}`, {
        signal: controller.signal,
        cache: "no-store",
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("search unavailable");
          const parsed = parseContextResourceSearchResponse(
            (await response.json()) as unknown,
          );
          if (!parsed) throw new Error("invalid search response");
          setContextResults(parsed.results);
          setContextScopes(parsed.scopes);
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") {
            return;
          }
          setContextResults([]);
          setContextError("Context search is temporarily unavailable.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setContextLoading(false);
        });
    }, CONTEXT_SEARCH_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [contextPaletteActive, contextScope, contextToken, threadId]);

  useEffect(() => {
    if (contextHighlight >= visibleContextResults.length) {
      setContextHighlight(0);
    }
  }, [contextHighlight, visibleContextResults.length]);

  useEffect(() => {
    const previousDraftStorageKey = hydratedDraftStorageKeyRef.current;
    hydratedDraftStorageKeyRef.current = draftStorageKey;
    skipNextDraftPersistRef.current = true;
    skipNextContextDraftPersistRef.current = true;
    if (draftTimerRef.current !== undefined) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = undefined;
    }
    if (!draftStorageKey) return;
    try {
      if (!restoreDraft) {
        window.localStorage.removeItem(draftStorageKey);
        if (contextDraftStorageKey) {
          window.localStorage.removeItem(contextDraftStorageKey);
        }
        latestDraftRef.current = { storageKey: draftStorageKey, text: "" };
        setText("");
        setContextResources([]);
        return;
      }
      const pendingText =
        previousDraftStorageKey === null ? latestDraftRef.current.text : "";
      const restored = window.localStorage.getItem(draftStorageKey) ?? "";
      const nextText =
        pendingText && restored && pendingText !== restored
          ? `${restored}\n\n${pendingText}`
          : pendingText || restored;
      const restoredContext = contextDraftStorageKey
        ? window.localStorage.getItem(contextDraftStorageKey)
        : null;
      latestDraftRef.current = { storageKey: draftStorageKey, text: nextText };
      setText(nextText);
      if (pendingText) {
        persistComposerDraft(draftStorageKey, nextText);
      }
      setContextResources(parseStoredContextResources(restoredContext));
    } catch {
      // Storage may be unavailable in private or locked-down browsers.
    }
  }, [contextDraftStorageKey, draftStorageKey, restoreDraft]);

  useEffect(() => {
    if (
      !editRequest ||
      handledEditRequestRef.current === editRequest.requestId
    ) {
      return;
    }
    if (!editBackupRef.current) {
      editBackupRef.current = {
        text,
        attachments,
        activeSkill,
        contextResources,
      };
    }
    persistComposerDraft(draftStorageKey, text);
    latestDraftRef.current = { storageKey: draftStorageKey, text };
    handledEditRequestRef.current = editRequest.requestId;
    setText(editRequest.content);
    setAttachments([]);
    setActiveSkill(null);
    setContextResources(
      contextResourceSearchResultsFromManifest(
        editRequest.contextResourceReferences,
        editRequest.contextResourceManifest,
      ),
    );
    setNotice(null);
    window.setTimeout(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(
        editRequest.content.length,
        editRequest.content.length,
      );
    }, 0);
  }, [
    activeSkill,
    attachments,
    contextResources,
    draftStorageKey,
    editRequest,
    text,
  ]);

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
    if (skipNextContextDraftPersistRef.current) {
      skipNextContextDraftPersistRef.current = false;
      return;
    }
    if (editRequest) return;
    persistContextDraft(contextDraftStorageKey, contextResources);
  }, [contextDraftStorageKey, contextResources, editRequest]);

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

  function selectContextResource(resource: ContextResourceSearchResult) {
    if (!contextToken) return;
    const key = contextResourceReferenceKey(resource.reference);
    const alreadySelected = contextResources.some(
      (candidate) => contextResourceReferenceKey(candidate.reference) === key,
    );
    if (
      !alreadySelected &&
      contextResources.length >= MAX_CONTEXT_RESOURCE_REFERENCES
    ) {
      setNotice(
        `You can select up to ${MAX_CONTEXT_RESOURCE_REFERENCES} resources per message.`,
      );
      return;
    }
    if (!alreadySelected) {
      setContextResources((previous) => [...previous, resource]);
    }
    const nextText =
      text.slice(0, contextToken.start) + text.slice(contextToken.end);
    setText(nextText);
    setCursorPosition(contextToken.start);
    setContextResults([]);
    setContextError(null);
    window.setTimeout(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(contextToken.start, contextToken.start);
    }, 0);
  }

  function removeContextResource(index: number) {
    setContextResources((previous) =>
      previous.filter((_, itemIndex) => itemIndex !== index),
    );
  }

  function openContextPicker() {
    const textarea = taRef.current;
    const start = textarea?.selectionStart ?? text.length;
    const end = textarea?.selectionEnd ?? start;
    const prefix = text.slice(0, start);
    const insertion = prefix.length > 0 && !/\s$/.test(prefix) ? " @" : "@";
    const next = prefix + insertion + text.slice(end);
    const cursor = prefix.length + insertion.length;
    setText(next);
    setCursorPosition(cursor);
    setContextScope("workspace");
    window.setTimeout(() => {
      textarea?.focus();
      textarea?.setSelectionRange(cursor, cursor);
    }, 0);
  }

  async function addFiles(files: FileList | File[]) {
    if (queueMode) {
      setNotice(
        "Files cannot be queued yet. Wait for the current run to finish, then attach them to the next message.",
      );
      return;
    }
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
      const isImage = attachmentKindForName(file.name) === "image";
      const maxBytes = isImage
        ? MAX_RUNTIME_IMAGE_BYTES
        : MAX_ATTACHMENT_BYTES;
      if (file.size > maxBytes) {
        setNotice(
          `"${file.name}" is ${formatBytes(file.size)} — the limit is ${isImage ? "3.75 MB for image analysis" : `${formatBytes(MAX_ATTACHMENT_BYTES)} per file`}. Compress or resize it and try again.`,
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
      setAttachments((prev) =>
        dedupeChatAttachments([...prev, ...next]).slice(0, MAX_ATTACHMENTS),
      );
      setNotice(null);
    }
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
  }

  function clearPersistedDraft() {
    if (draftTimerRef.current !== undefined) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = undefined;
    }
    latestDraftRef.current = { storageKey: draftStorageKey, text: "" };
    persistComposerDraft(draftStorageKey, "");
    persistContextDraft(contextDraftStorageKey, []);
  }

  function completeSubmission() {
    clearPersistedDraft();
    latestDraftRef.current = { storageKey: draftStorageKey, text: "" };
    editBackupRef.current = null;
    handledEditRequestRef.current = undefined;
    setText("");
    setActiveSkill(null);
    setAttachments([]);
    setContextResources([]);
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
    setContextResources(backup?.contextResources ?? []);
    setNotice(null);
    onEditComplete?.();
    window.setTimeout(() => taRef.current?.focus(), 0);
  }

  function send() {
    const trimmed = text.trim();
    if (
      (!trimmed && attachments.length === 0 && activeSkill === null) ||
      disabled ||
      submitDisabled
    ) {
      return;
    }
    if (queueMode && attachments.length > 0) {
      setNotice(
        "Files cannot be queued yet. Keep this draft, then attach the files after the current run finishes.",
      );
      return;
    }
    if (queueMode && editRequest) {
      setNotice(
        "A saved message cannot be edited while another run is active. This draft is still here for later.",
      );
      return;
    }

    if (activeSkill) {
      if (
        onSubmit(
          buildSlashSkillDisplayMessage(activeSkill, trimmed),
          attachments.length > 0 ? attachments : undefined,
          buildActivatedSlashSkill(activeSkill, trimmed),
          undefined,
          editRequest?.messageId,
          contextResources.length > 0 ? contextResources : undefined,
        ) !== false
      ) {
        completeSubmission();
      }
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
      if (
        onSubmit(
          buildModelCommandDisplayMessage(parsed.override, parsed.body),
          attachments.length > 0 ? attachments : undefined,
          undefined,
          parsed.override,
          editRequest?.messageId,
          contextResources.length > 0 ? contextResources : undefined,
        ) !== false
      ) {
        completeSubmission();
      }
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
      if (
        onSubmit(
          buildSlashSkillDisplayMessage(resolved.skill, resolved.args),
          attachments.length > 0 ? attachments : undefined,
          buildActivatedSlashSkill(resolved.skill, resolved.args),
          undefined,
          editRequest?.messageId,
          contextResources.length > 0 ? contextResources : undefined,
        ) !== false
      ) {
        completeSubmission();
      }
      return;
    }

    if (
      onSubmit(
        trimmed,
        attachments.length > 0 ? attachments : undefined,
        undefined,
        undefined,
        editRequest?.messageId,
        contextResources.length > 0 ? contextResources : undefined,
      ) !== false
    ) {
      completeSubmission();
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    send();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (contextPaletteActive && contextToken) {
      if (e.key === "ArrowDown" && visibleContextResults.length > 0) {
        e.preventDefault();
        setContextHighlight(
          (highlighted) =>
            (highlighted + 1) % visibleContextResults.length,
        );
        return;
      }
      if (e.key === "ArrowUp" && visibleContextResults.length > 0) {
        e.preventDefault();
        setContextHighlight(
          (highlighted) =>
            (highlighted - 1 + visibleContextResults.length) %
            visibleContextResults.length,
        );
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        const next =
          text.slice(0, contextToken.start) + text.slice(contextToken.end);
        setText(next);
        setCursorPosition(contextToken.start);
        return;
      }
      if (
        (e.key === "Tab" ||
          (e.key === "Enter" &&
            !e.shiftKey &&
            !e.nativeEvent.isComposing)) &&
        visibleContextResults.length > 0
      ) {
        e.preventDefault();
        selectContextResource(
          visibleContextResults[
            Math.min(contextHighlight, visibleContextResults.length - 1)
          ]!,
        );
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        return;
      }
    }
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
          <p className="border-b border-hairline px-3 py-1.5 text-2xs uppercase tracking-wider text-muted">
            Capabilities
          </p>
          {matches.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted">
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
                    <span className="shrink-0 text-sm font-medium text-ink">
                      {skill.name}
                    </span>
                    {skill.mcpProviders.length > 0 ? (
                      <span className="shrink-0 rounded bg-ink/5 px-1.5 py-0.5 text-2xs uppercase tracking-wide text-muted">
                        {skill.mcpProviders.join(" · ")}
                      </span>
                    ) : null}
                    <span className="min-w-0 flex-1 truncate text-xs text-muted">
                      {skill.description}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-hairline px-3 py-1.5 text-2xs text-muted">
            ↑↓ choose · Enter select · Tab select · Esc dismiss
          </p>
        </div>
      ) : null}
      {contextPaletteActive ? (
        <div
          data-testid="context-resource-palette"
          className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-lg border border-hairline bg-canvas shadow-xl"
        >
          <div className="flex items-center gap-2 border-b border-hairline px-3 py-1.5">
            {contextScope !== "workspace" ? (
              <button
                type="button"
                aria-label="Back to workspace context"
                onClick={() => setContextScope("workspace")}
                className="text-sm text-muted hover:text-ink"
              >
                ‹
              </button>
            ) : null}
            <p className="text-2xs uppercase tracking-wider text-muted">
              {contextScope === "workspace" ? "Add context" : "Search Gmail"}
            </p>
            {contextLoading ? (
              <span className="ml-auto text-2xs text-muted">Searching…</span>
            ) : null}
          </div>
          {contextScope === "workspace" && contextScopes.length > 0 ? (
            <div className="border-b border-hairline py-1">
              {contextScopes.map((scope) => (
                <button
                  key={scope.scope}
                  type="button"
                  disabled={!scope.available}
                  title={
                    scope.available ? scope.description : scope.unavailableReason
                  }
                  onClick={() => {
                    setContextScope(scope.scope);
                    setContextHighlight(0);
                  }}
                  className="flex w-full items-baseline gap-2 px-3 py-2 text-left hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <span className="shrink-0 text-sm font-medium text-ink">
                    {scope.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted">
                    {scope.available
                      ? scope.description
                      : scope.unavailableReason}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {contextError ? (
            <p className="px-3 py-3 text-sm text-danger">{contextError}</p>
          ) : visibleContextResults.length === 0 && !contextLoading ? (
            <p className="px-3 py-3 text-sm text-muted">
              {contextToken?.query
                ? "No matching resources."
                : contextScope === "workspace"
                  ? "Start typing to find files, Vault memory, and app versions."
                  : "Start typing to search Gmail."}
            </p>
          ) : (
            <ul className="max-h-64 overflow-y-auto py-1">
              {visibleContextResults.map((resource, index) => (
                <li key={contextResourceReferenceKey(resource.reference)}>
                  <button
                    type="button"
                    onMouseEnter={() => setContextHighlight(index)}
                    onClick={() => selectContextResource(resource)}
                    className={`flex w-full min-w-0 items-baseline gap-2 px-3 py-2 text-left ${
                      index === contextHighlight ? "bg-subtle" : ""
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                      {resource.label}
                    </span>
                    {resource.versionLabel ? (
                      <span className="shrink-0 text-2xs text-muted">
                        {resource.versionLabel}
                      </span>
                    ) : null}
                    <span className="shrink-0 text-2xs uppercase tracking-wide text-muted">
                      {resource.sourceLabel}
                    </span>
                    <span className="hidden min-w-0 max-w-64 truncate text-xs text-muted sm:block">
                      {resource.description}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-hairline px-3 py-1.5 text-2xs text-muted">
            ↑↓ choose · Enter select · Tab select · Esc dismiss
          </p>
        </div>
      ) : null}

      {dictation.listening ? (
        <p className="mb-1.5 flex items-center gap-2 px-1 text-xs text-danger/80">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
          Listening… {dictation.interim ? `“${dictation.interim}”` : "speak now"}
        </p>
      ) : null}
      {editRequest ? (
        <div
          data-testid="edit-message-state"
          className="mb-1.5 flex items-center justify-between gap-2 px-1 text-xs text-muted"
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
        <div className="mb-1.5 flex flex-wrap items-center gap-2 px-1 text-xs text-muted">
          <span
            data-testid="active-slash-skill"
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-hairline bg-subtle px-2 py-1 text-ink"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-info" />
            <span className="font-mono">{slashSkillToken(activeSkill)}</span>
            <span className="text-muted">{activeSkill.name}</span>
            <button
              type="button"
              aria-label={`Remove ${activeSkill.name}`}
              onClick={() => setActiveSkill(null)}
              className="ml-0.5 text-muted hover:text-ink"
            >
              ×
            </button>
          </span>
          <span className="text-muted">Active for this message</span>
        </div>
      ) : notice ? (
        <p className="mb-1.5 px-1 text-xs text-muted">{notice}</p>
      ) : queueMode ? (
        <p className="mb-1.5 px-1 text-xs text-muted">
          This follow-up will send automatically after the current run.
        </p>
      ) : null}

      {contextResources.length > 0 ? (
        <div
          data-testid="selected-context-resources"
          className="mb-1.5 flex flex-wrap gap-1.5 px-1"
        >
          {contextResources.map((resource, index) => (
            <span
              key={contextResourceReferenceKey(resource.reference)}
              className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-info/35 bg-info/10 px-2 py-1 text-xs text-ink"
            >
              <span className="shrink-0 font-mono text-info">@</span>
              <span className="max-w-48 truncate">{resource.label}</span>
              <span className="shrink-0 text-2xs text-muted">
                {resource.sourceLabel}
              </span>
              <button
                type="button"
                aria-label={`Remove ${resource.label}`}
                onClick={() => removeContextResource(index)}
                className="text-muted hover:text-ink"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {attachments.length > 0 ? (
        <div className="mb-1.5 flex flex-wrap gap-1.5 px-1">
          {attachments.map((a, index) => (
            <span
              key={`${a.name}:${a.sizeBytes ?? "unknown"}:${index}`}
              className="flex items-center gap-1.5 rounded-md border border-hairline bg-subtle px-2 py-1 text-xs text-ink"
            >
              <PaperclipIcon />
              <span className="max-w-40 truncate">{a.name}</span>
              {typeof a.sizeBytes === "number" ? (
                <span className="text-muted">{formatBytes(a.sizeBytes)}</span>
              ) : null}
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                onClick={() => removeAttachment(index)}
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
            : "border-hairline"
        }`}
      >
        <input
          ref={fileRef}
          data-testid="chat-file-input"
          type="file"
          multiple
          disabled={disabled || queueMode || !uploadReady}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          aria-label="Add context"
          title="Add context"
          disabled={disabled}
          onClick={openContextPicker}
          className="flex h-11 w-9 shrink-0 items-center justify-center gap-1 rounded-md font-mono text-sm text-muted hover:text-ink disabled:opacity-30 sm:h-7 sm:w-auto sm:px-2"
        >
          <span aria-hidden="true">@</span>
          <span className="hidden font-sans text-xs sm:inline">Context</span>
        </button>
        <button
          type="button"
          aria-label="Attach files"
          title={queueMode ? "Files cannot be queued during an active run" : "Attach files"}
          disabled={disabled || queueMode || !uploadReady}
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
          data-testid="chat-composer-input"
          data-composer-ready={!disabled && !submitDisabled ? "true" : "false"}
          aria-label="Message"
          ref={taRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCursorPosition(e.target.selectionStart ?? e.target.value.length);
            if (notice) setNotice(null);
          }}
          onSelect={(e) =>
            setCursorPosition(e.currentTarget.selectionStart ?? text.length)
          }
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
          className="flex-1 resize-none bg-transparent px-2 py-2 text-base text-ink placeholder:text-muted disabled:opacity-50 sm:py-1.5"
        />
        <button
          type="submit"
          disabled={
            disabled ||
            submitDisabled ||
            (!text.trim() && attachments.length === 0 && activeSkill === null)
          }
          aria-label={queueMode ? "Queue follow-up" : "Send"}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-pop text-on-pop hover:bg-pop/90 disabled:opacity-30 sm:h-7 sm:w-7"
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

function findContextToken(
  text: string,
  cursor: number,
): { start: number; end: number; query: string } | null {
  const beforeCursor = text.slice(0, Math.max(0, Math.min(cursor, text.length)));
  const match = /(^|\s)@([^@\n]{0,80})$/.exec(beforeCursor);
  if (!match) return null;
  return {
    start: match.index + match[1]!.length,
    end: beforeCursor.length,
    query: match[2]!.trim(),
  };
}

function parseStoredContextResources(
  raw: string | null,
): ContextResourceSearchResult[] {
  if (!raw) return [];
  try {
    const parsed = parseContextResourceSearchResponse({
      results: JSON.parse(raw) as unknown,
      scopes: [],
    });
    return parsed?.results.slice(0, MAX_CONTEXT_RESOURCE_REFERENCES) ?? [];
  } catch {
    return [];
  }
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
