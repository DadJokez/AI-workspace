export interface ChatMessageEditCandidate {
  id: string;
  role: "user" | "assistant" | "tool";
}

export type ChatMessageEditPlan =
  | { ok: true; targetId: string; deleteIds: string[] }
  | { ok: false; error: "message_not_found" | "message_not_editable" };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isChatMessageEditId(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Plan a same-thread edit branch. The selected user message keeps its stable
 * id; every later message is removed before the replacement turn runs.
 */
export function planChatMessageEdit(
  messages: readonly ChatMessageEditCandidate[],
  targetId: string,
): ChatMessageEditPlan {
  const targetIndex = messages.findIndex((message) => message.id === targetId);
  if (targetIndex === -1) {
    return { ok: false, error: "message_not_found" };
  }
  if (messages[targetIndex]!.role !== "user") {
    return { ok: false, error: "message_not_editable" };
  }

  return {
    ok: true,
    targetId,
    deleteIds: messages.slice(targetIndex + 1).map((message) => message.id),
  };
}
