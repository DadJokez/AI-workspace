import {
  parseSlashDisplayMessage,
  type ActivatedSlashSkill,
} from "@/lib/skill-commands";
import {
  parseModelCommand,
  type ChatModelOverride,
} from "@/lib/model-command";

export const CHAT_TURN_QUEUE_STORAGE_PREFIX = "comparative-chat-queue:v1:";

export type QueuedChatTurnStatus = "queued" | "sending" | "failed";

export interface QueuedChatTurnDraft {
  text: string;
  activatedSkill?: ActivatedSlashSkill;
  modelOverride?: ChatModelOverride;
}

export interface QueuedChatTurn extends QueuedChatTurnDraft {
  id: string;
  createdAt: string;
  status: QueuedChatTurnStatus;
  error?: string;
}

export function chatTurnQueueStorageKey({
  userId,
  tabId,
  threadId,
}: {
  userId?: string;
  tabId?: string;
  threadId?: string;
}): string | null {
  if (!userId || !tabId) return null;
  const scope = threadId ? `thread:${threadId}` : `tab:${tabId}`;
  return `${CHAT_TURN_QUEUE_STORAGE_PREFIX}${userId}:${scope}`;
}

export function createQueuedChatTurn(
  draft: QueuedChatTurnDraft,
  values: { id?: string; createdAt?: string } = {},
): QueuedChatTurn {
  return {
    ...normalizeQueuedTurnPayload(draft),
    id: values.id ?? crypto.randomUUID(),
    createdAt: values.createdAt ?? new Date().toISOString(),
    status: "queued",
  };
}

export function parseQueuedChatTurns(raw: string | null): QueuedChatTurn[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const turns: QueuedChatTurn[] = [];
    for (const item of value) {
      const parsed = parseQueuedChatTurn(item);
      if (!parsed || seen.has(parsed.id)) continue;
      seen.add(parsed.id);
      turns.push(parsed);
    }
    return turns;
  } catch {
    return [];
  }
}

export function mergeQueuedChatTurns(
  first: readonly QueuedChatTurn[],
  second: readonly QueuedChatTurn[],
): QueuedChatTurn[] {
  const seen = new Set<string>();
  const merged: QueuedChatTurn[] = [];
  // The first scope carries the user's latest manual order during migration.
  for (const turn of [...first, ...second]) {
    if (seen.has(turn.id)) continue;
    seen.add(turn.id);
    merged.push(turn);
  }
  return merged;
}

export function editQueuedChatTurn(
  turn: QueuedChatTurn,
  text: string,
): QueuedChatTurn {
  return {
    id: turn.id,
    createdAt: turn.createdAt,
    ...normalizeQueuedTurnPayload({
      text,
      activatedSkill: turn.activatedSkill,
      modelOverride: turn.modelOverride,
    }),
    status: "queued",
  };
}

export function moveQueuedChatTurn(
  turns: readonly QueuedChatTurn[],
  id: string,
  offset: -1 | 1,
): QueuedChatTurn[] {
  const index = turns.findIndex((turn) => turn.id === id);
  const destination = index + offset;
  if (index < 0 || destination < 0 || destination >= turns.length) {
    return [...turns];
  }
  const next = [...turns];
  const [turn] = next.splice(index, 1);
  next.splice(destination, 0, turn!);
  return next;
}

export function moveQueuedChatTurnToFront(
  turns: readonly QueuedChatTurn[],
  id: string,
): QueuedChatTurn[] {
  const turn = turns.find((candidate) => candidate.id === id);
  if (!turn) return [...turns];
  return [
    { ...turn, status: "queued", error: undefined },
    ...turns.filter((candidate) => candidate.id !== id),
  ];
}

function normalizeQueuedTurnPayload(
  draft: QueuedChatTurnDraft,
): QueuedChatTurnDraft {
  const text = draft.text.trim();
  if (draft.activatedSkill) {
    const parsed = parseSlashDisplayMessage(text);
    const expectedToken = `/${draft.activatedSkill.slug}`.toLowerCase();
    return {
      text,
      ...(parsed?.token.toLowerCase() === expectedToken
        ? {
            activatedSkill: {
              ...draft.activatedSkill,
              args: parsed.body,
            },
          }
        : {}),
    };
  }
  if (draft.modelOverride) {
    const parsed = parseModelCommand(text);
    return {
      text,
      ...(parsed ? { modelOverride: parsed.override } : {}),
    };
  }
  return { text };
}

function parseQueuedChatTurn(value: unknown): QueuedChatTurn | null {
  if (!isRecord(value)) return null;
  if (!isUuid(value.id) || typeof value.text !== "string") return null;
  const text = value.text.trim();
  if (!text || typeof value.createdAt !== "string") return null;
  const activatedSkill = parseActivatedSkill(value.activatedSkill);
  const modelOverride = parseModelOverride(value.modelOverride);
  const status: QueuedChatTurnStatus =
    value.status === "failed" ? "failed" : "queued";
  return {
    id: value.id,
    createdAt: value.createdAt,
    status,
    ...normalizeQueuedTurnPayload({
      text,
      ...(activatedSkill ? { activatedSkill } : {}),
      ...(modelOverride ? { modelOverride } : {}),
    }),
    ...(status === "failed" && typeof value.error === "string"
      ? { error: value.error }
      : {}),
  };
}

function parseActivatedSkill(value: unknown): ActivatedSlashSkill | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.slug !== "string" ||
    typeof value.name !== "string" ||
    typeof value.args !== "string" ||
    value.source !== "explicit"
  ) {
    return undefined;
  }
  return {
    id: value.id,
    slug: value.slug,
    name: value.name,
    args: value.args,
    source: "explicit",
  };
}

function parseModelOverride(value: unknown): ChatModelOverride | undefined {
  if (!isRecord(value) || typeof value.label !== "string") return undefined;
  if (value.mode === "auto" && value.label === "auto") {
    return { mode: "auto", label: "auto" };
  }
  if (value.mode === "model" && typeof value.modelId === "string") {
    return value as ChatModelOverride;
  }
  return undefined;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
