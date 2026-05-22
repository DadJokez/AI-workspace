import { DEFAULT_MODEL_ID } from "@ai-workspace/agent";
import { getRuntime } from "@ai-workspace/cursor-runtime";
import {
  chatMessages,
  chatThreads,
  type Database,
  memoryCaptureQueue,
  type MemoryCaptureQueueItem,
  userMemoryItems,
  type UserMemoryItem,
} from "@ai-workspace/db";
import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  buildVaultMarkdown,
  loadUserMemoryItems,
  normalizeMemoryCategory,
} from "@/lib/vault-memory";

const DEFAULT_CAPTURE_LIMIT = 40;
const DEFAULT_WORKER_POLL_MS = 20 * 60 * 1000;
const DEFAULT_IN_PROCESS_DELAY_MS = 20 * 60 * 1000;
const DEFAULT_PROCESSING_STALE_MS = 30 * 60 * 1000;
const MAX_REVIEW_DOC_CHARS = 90_000;
const MAX_MESSAGE_CHARS = 12_000;
const MAX_MEMORY_BODY_CHARS = 600;
const MAX_MEMORY_TITLE_CHARS = 120;

export interface EnqueueMemoryCaptureInput {
  userId: string;
  threadId: string;
  fromMessageId: string;
  toMessageId: string;
  recipeRunId?: string | null;
  reason?: string;
}

export interface ProcessMemoryCaptureInput {
  db: Database;
  userId?: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface MemoryCaptureWorkerLoopInput extends ProcessMemoryCaptureInput {
  pollIntervalMs?: number;
}

type MemoryCaptureWorkerStatus = "idle" | "processed" | "failed";

let inProcessTimer: ReturnType<typeof setTimeout> | undefined;
let inProcessRunning = false;

interface CapturedMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: Date;
}

interface ExtractedSuggestion {
  category: string;
  title: string;
  bodyMd: string;
  confidence: number;
  reason: string | null;
  sourceThreadId: string | null;
  sourceMessageIds: string[];
}

export async function enqueueMemoryCapture(
  db: Database,
  input: EnqueueMemoryCaptureInput,
): Promise<void> {
  await db
    .insert(memoryCaptureQueue)
    .values({
      userId: input.userId,
      threadId: input.threadId,
      fromMessageId: input.fromMessageId,
      toMessageId: input.toMessageId,
      recipeRunId: input.recipeRunId ?? null,
      reason: input.reason ?? "chat_turn",
    })
    .onConflictDoNothing();
}

export function startInProcessMemoryCaptureScheduler({
  db,
}: {
  db: Database;
}): void {
  if (process.env.MEMORY_CAPTURE_IN_PROCESS_SCHEDULER === "0") return;
  if (inProcessTimer || inProcessRunning) return;

  const delayMs =
    numberFromEnv("MEMORY_CAPTURE_DELAY_MS") ?? DEFAULT_IN_PROCESS_DELAY_MS;
  inProcessTimer = setTimeout(() => {
    inProcessTimer = undefined;
    inProcessRunning = true;
    void processPendingMemoryCaptures({ db })
      .catch((err) => {
        process.stderr.write(
          `[memory-capture-in-process-error] ${JSON.stringify({
            message: err instanceof Error ? err.message : String(err),
          })}\n`,
        );
      })
      .finally(() => {
        inProcessRunning = false;
      });
  }, Math.max(0, delayMs));
  inProcessTimer.unref?.();
}

export async function runMemoryCaptureWorkerLoop({
  db,
  userId,
  limit,
  pollIntervalMs = numberFromEnv("MEMORY_CAPTURE_WORKER_POLL_INTERVAL_MS") ??
    DEFAULT_WORKER_POLL_MS,
  signal,
}: MemoryCaptureWorkerLoopInput): Promise<void> {
  while (!signal?.aborted) {
    const result = await processPendingMemoryCaptures({
      db,
      userId,
      limit,
      signal,
    });
    if (result.status === "idle") {
      await delay(pollIntervalMs, signal);
    }
  }
}

export async function processPendingMemoryCaptures({
  db,
  userId,
  limit = numberFromEnv("MEMORY_CAPTURE_BATCH_LIMIT") ??
    DEFAULT_CAPTURE_LIMIT,
  signal,
}: ProcessMemoryCaptureInput): Promise<{
  status: MemoryCaptureWorkerStatus;
  captures: number;
  suggestions: number;
}> {
  const claimed = await claimPendingCaptures(db, {
    userId,
    limit,
  });
  if (claimed.length === 0) {
    return { status: "idle", captures: 0, suggestions: 0 };
  }

  let totalSuggestions = 0;
  let failed = false;
  for (const group of groupCapturesByUser(claimed)) {
    if (signal?.aborted) break;
    try {
      totalSuggestions += await processCaptureGroup(db, group, signal);
    } catch (err) {
      failed = true;
      const message = err instanceof Error ? err.message : String(err);
      await markCaptures(db, group.map((row) => row.id), "failed", message);
      process.stderr.write(
        `[memory-capture-error] ${JSON.stringify({
          userId: group[0]?.userId,
          captures: group.length,
          message,
        })}\n`,
      );
    }
  }

  return {
    status: failed ? "failed" : "processed",
    captures: claimed.length,
    suggestions: totalSuggestions,
  };
}

async function claimPendingCaptures(
  db: Database,
  {
    userId,
    limit,
  }: {
    userId?: string;
    limit: number;
  },
): Promise<MemoryCaptureQueueItem[]> {
  const staleBefore = new Date(
    Date.now() -
      (numberFromEnv("MEMORY_CAPTURE_PROCESSING_STALE_MS") ??
        DEFAULT_PROCESSING_STALE_MS),
  );
  const claimable = or(
    eq(memoryCaptureQueue.status, "pending"),
    and(
      eq(memoryCaptureQueue.status, "processing"),
      lt(memoryCaptureQueue.claimedAt, staleBefore),
    ),
  );
  const conditions = [claimable];
  if (userId) conditions.push(eq(memoryCaptureQueue.userId, userId));

  const pending = await db
    .select()
    .from(memoryCaptureQueue)
    .where(and(...conditions))
    .orderBy(asc(memoryCaptureQueue.createdAt))
    .limit(Math.max(1, limit));

  const ids = pending.map((row) => row.id);
  if (ids.length === 0) return [];

  const now = new Date();
  return db
    .update(memoryCaptureQueue)
    .set({
      status: "processing",
      attemptCount: sql`${memoryCaptureQueue.attemptCount} + 1`,
      claimedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        inArray(memoryCaptureQueue.id, ids),
        claimable,
      ),
    )
    .returning();
}

async function processCaptureGroup(
  db: Database,
  captures: MemoryCaptureQueueItem[],
  signal?: AbortSignal,
): Promise<number> {
  const userId = captures[0]?.userId;
  if (!userId) return 0;

  const activeMemory = await loadUserMemoryItems(db, userId, [
    "approved",
    "suggested",
  ]);
  const reviewDoc = await buildMemoryReviewDocument(db, captures, activeMemory);
  if (!reviewDoc.trim()) {
    await markCaptures(db, captures.map((row) => row.id), "skipped");
    return 0;
  }

  const suggestions = await extractMemorySuggestions({
    db,
    userId,
    reviewDoc,
    signal,
  });
  const inserted = await insertNewSuggestions({
    db,
    userId,
    captures,
    activeMemory,
    suggestions,
  });
  await markCaptures(db, captures.map((row) => row.id), "processed");
  return inserted;
}

async function buildMemoryReviewDocument(
  db: Database,
  captures: MemoryCaptureQueueItem[],
  activeMemory: UserMemoryItem[],
): Promise<string> {
  const approvedMarkdown = buildVaultMarkdown(
    activeMemory.filter((item) => item.status === "approved"),
  );
  const suggested = activeMemory.filter((item) => item.status === "suggested");
  const threadIds = [...new Set(captures.map((row) => row.threadId))];
  const threadRows =
    threadIds.length > 0
      ? await db
          .select({
            id: chatThreads.id,
            title: chatThreads.title,
          })
          .from(chatThreads)
          .where(inArray(chatThreads.id, threadIds))
      : [];
  const threadTitles = new Map(
    threadRows.map((row) => [row.id, row.title ?? "Untitled chat"]),
  );

  const lines: string[] = [
    "# Existing Approved Vault Memory",
    approvedMarkdown || "(none)",
    "",
    "# Existing Suggested Vault Updates",
    suggested.length === 0
      ? "(none)"
      : suggested
          .map(
            (item) =>
              `- [${item.category}] ${item.title}: ${stripMarkdownBullet(
                item.bodyMd,
              )}`,
          )
          .join("\n"),
    "",
    "# Queued Conversation Material",
  ];

  for (const capture of captures) {
    const messages = await loadCaptureMessages(db, capture);
    if (messages.length === 0) continue;
    lines.push(
      "",
      `## Capture ${capture.id}`,
      `Thread: ${threadTitles.get(capture.threadId) ?? "Untitled chat"}`,
      `Thread ID: ${capture.threadId}`,
      `Reason: ${capture.reason}`,
    );
    for (const message of messages) {
      lines.push(
        "",
        `### ${roleLabel(message.role)} message ${message.id}`,
        `Date: ${message.createdAt.toISOString()}`,
        truncate(message.content, MAX_MESSAGE_CHARS),
      );
    }
    if (lines.join("\n").length > MAX_REVIEW_DOC_CHARS) {
      lines.push("", "[Review document truncated for memory capture budget]");
      break;
    }
  }

  return truncate(lines.join("\n"), MAX_REVIEW_DOC_CHARS);
}

async function loadCaptureMessages(
  db: Database,
  capture: MemoryCaptureQueueItem,
): Promise<CapturedMessage[]> {
  const messages = await db
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, capture.threadId))
    .orderBy(asc(chatMessages.createdAt));

  const fromIdx = messages.findIndex((m) => m.id === capture.fromMessageId);
  const toIdx = messages.findIndex((m) => m.id === capture.toMessageId);
  if (fromIdx === -1 || toIdx === -1) {
    return messages.filter(
      (m) => m.id === capture.fromMessageId || m.id === capture.toMessageId,
    );
  }
  const start = Math.min(fromIdx, toIdx);
  const end = Math.max(fromIdx, toIdx);
  return messages.slice(start, end + 1);
}

async function extractMemorySuggestions({
  db,
  userId,
  reviewDoc,
  signal,
}: {
  db: Database;
  userId: string;
  reviewDoc: string;
  signal?: AbortSignal;
}): Promise<ExtractedSuggestion[]> {
  const runtime = getRuntime({ db });
  let text = "";
  const errors: string[] = [];
  const modelId = process.env.MEMORY_CAPTURE_MODEL_ID ?? DEFAULT_MODEL_ID;
  const systemPrompt = [
    "You are AI Hub's Vault memory reviewer.",
    "Extract only durable, user-useful personal context from queued chats.",
    "Never store secrets, credentials, private keys, access tokens, passwords, or sensitive personal data.",
    "Prefer stable preferences, working style, active projects, durable constraints, systems, and decisions.",
    "Do not record routine task chatter, jokes, one-off implementation details, or facts already present in existing memory.",
    "Return strict JSON only.",
  ].join(" ");
  const prompt = [
    "Review the markdown document below and propose Vault memory updates.",
    "",
    "Return exactly this JSON shape:",
    '{"suggestions":[{"category":"current_priorities","title":"Short title","bodyMd":"One durable markdown bullet or sentence.","confidence":85,"reason":"Why this should be remembered.","sourceThreadId":"thread uuid","sourceMessageIds":["message uuid"]}]}',
    "",
    "Allowed categories: current_priorities, projects, working_style, communication, preferences, systems, constraints, decisions, personal_context.",
    "Use confidence from 0 to 100. Return an empty suggestions array if nothing should be remembered.",
    "",
    reviewDoc,
  ].join("\n");

  for await (const ev of runtime.runTurn({
    threadId: `memory-capture-${userId}-${Date.now()}`,
    modelId,
    systemPrompt,
    messages: [{ role: "user", content: prompt }],
    context: { userId },
    signal,
    firstTurnPreamble: systemPrompt,
  })) {
    if (ev.type === "text-delta") text += ev.delta;
    if (ev.type === "error") errors.push(ev.message);
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  return parseExtractorOutput(text);
}

async function insertNewSuggestions({
  db,
  userId,
  captures,
  activeMemory,
  suggestions,
}: {
  db: Database;
  userId: string;
  captures: MemoryCaptureQueueItem[];
  activeMemory: UserMemoryItem[];
  suggestions: ExtractedSuggestion[];
}): Promise<number> {
  const allowedThreadIds = new Set(captures.map((row) => row.threadId));
  const fallbackThreadId = captures[0]?.threadId ?? null;
  const fallbackMessageIds = [
    ...new Set(
      captures.flatMap((row) => [row.fromMessageId, row.toMessageId]),
    ),
  ];
  const allowedMessageIds = new Set(fallbackMessageIds);
  const existingKeys = new Set(activeMemory.map(memoryKey));
  const values = suggestions
    .map((suggestion) =>
      normalizeSuggestion({
        userId,
        suggestion,
        allowedThreadIds,
        allowedMessageIds,
        fallbackThreadId,
        fallbackMessageIds,
      }),
    )
    .filter((suggestion) => {
      const key = memoryKey(suggestion);
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    });

  if (values.length === 0) return 0;
  await db.insert(userMemoryItems).values(values);
  return values.length;
}

function normalizeSuggestion({
  userId,
  suggestion,
  allowedThreadIds,
  allowedMessageIds,
  fallbackThreadId,
  fallbackMessageIds,
}: {
  userId: string;
  suggestion: ExtractedSuggestion;
  allowedThreadIds: Set<string>;
  allowedMessageIds: Set<string>;
  fallbackThreadId: string | null;
  fallbackMessageIds: string[];
}): typeof userMemoryItems.$inferInsert {
  const category = normalizeMemoryCategory(suggestion.category);
  const title = truncate(cleanSingleLine(suggestion.title), MAX_MEMORY_TITLE_CHARS);
  const bodyMd = truncate(suggestion.bodyMd.trim(), MAX_MEMORY_BODY_CHARS);
  const sourceThreadId =
    suggestion.sourceThreadId && allowedThreadIds.has(suggestion.sourceThreadId)
      ? suggestion.sourceThreadId
      : fallbackThreadId;
  const sourceMessageIds = suggestion.sourceMessageIds.filter((id) =>
    allowedMessageIds.has(id),
  );
  return {
    userId,
    status: "suggested",
    category,
    title: title || category,
    bodyMd: bodyMd || title || category,
    confidence: clampInt(suggestion.confidence, 0, 100),
    reason: suggestion.reason?.trim() || null,
    sourceThreadId,
    sourceMessageIds:
      sourceMessageIds.length > 0 ? sourceMessageIds : fallbackMessageIds,
    suggestedBy: "memory-capture",
  };
}

function parseExtractorOutput(text: string): ExtractedSuggestion[] {
  const parsed = JSON.parse(extractJson(text)) as unknown;
  if (!parsed || typeof parsed !== "object") return [];
  const suggestions = (parsed as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(suggestions)) return [];
  return suggestions.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const raw = value as Record<string, unknown>;
    const title = stringValue(raw.title);
    const bodyMd = stringValue(raw.bodyMd);
    if (!title || !bodyMd) return [];
    return [
      {
        category: stringValue(raw.category) || "personal_context",
        title,
        bodyMd,
        confidence:
          typeof raw.confidence === "number" ? raw.confidence : Number(raw.confidence),
        reason: stringValue(raw.reason) || null,
        sourceThreadId: stringValue(raw.sourceThreadId) || null,
        sourceMessageIds: Array.isArray(raw.sourceMessageIds)
          ? raw.sourceMessageIds.filter(
              (id): id is string => typeof id === "string" && id.length > 0,
            )
          : [],
      },
    ];
  });
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) return text.slice(first, last + 1);
  return text.trim();
}

async function markCaptures(
  db: Database,
  ids: string[],
  status: MemoryCaptureQueueItem["status"],
  error?: string,
): Promise<void> {
  if (ids.length === 0) return;
  const now = new Date();
  await db
    .update(memoryCaptureQueue)
    .set({
      status,
      error: error ?? null,
      processedAt:
        status === "processed" || status === "skipped" || status === "failed"
          ? now
          : null,
      updatedAt: now,
    })
    .where(inArray(memoryCaptureQueue.id, ids));
}

function groupCapturesByUser(
  captures: MemoryCaptureQueueItem[],
): MemoryCaptureQueueItem[][] {
  const groups = new Map<string, MemoryCaptureQueueItem[]>();
  for (const capture of captures) {
    const group = groups.get(capture.userId) ?? [];
    group.push(capture);
    groups.set(capture.userId, group);
  }
  return [...groups.values()];
}

function memoryKey(item: Pick<UserMemoryItem, "category" | "title" | "bodyMd">) {
  return [item.category, item.title, item.bodyMd]
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function roleLabel(role: CapturedMessage["role"]): string {
  if (role === "assistant") return "Assistant";
  if (role === "tool") return "Tool";
  return "User";
}

function stripMarkdownBullet(value: string): string {
  return value.trim().replace(/^[-*]\s+/, "");
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 35)).trimEnd()}\n[truncated for review budget]`;
}

function cleanSingleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
