import {
  auditLog,
  chatMessages,
  type Database,
  runs,
} from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";

export interface PersistAssistantMessageInput {
  db: Database;
  runId: string;
  userId: string;
  threadId: string;
  lane: "inline" | "worker";
  expectedWorkerId?: string;
  content: string;
  modelId: string;
  runtime: string;
  tokensIn: number;
  tokensOut: number;
  toolCalls: unknown;
  toolResults: unknown;
}

export interface PersistAssistantMessageResult {
  assistantMessageId: string;
  created: boolean;
}

/**
 * The run row is the idempotency register for its one assistant turn.
 * Locking it makes lease reclaims and duplicate completion attempts converge
 * on one chat message without adding another schema-level idempotency key.
 */
export async function persistAssistantMessageOnce({
  db,
  runId,
  userId,
  threadId,
  lane,
  expectedWorkerId,
  content,
  modelId,
  runtime,
  tokensIn,
  tokensOut,
  toolCalls,
  toolResults,
}: PersistAssistantMessageInput): Promise<PersistAssistantMessageResult | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        status: runs.status,
        workerId: runs.workerId,
        outputs: runs.outputs,
      })
      .from(runs)
      .where(
        and(
          eq(runs.id, runId),
          eq(runs.userId, userId),
          eq(runs.threadId, threadId),
        ),
      )
      .for("update");
    const run = rows[0];
    if (!run || run.status === "canceled") return null;
    if (expectedWorkerId && run.workerId !== expectedWorkerId) return null;

    const currentOutputs = asRecord(run.outputs);
    const existingId = currentOutputs.assistantMessageId;
    if (typeof existingId === "string" && existingId.length > 0) {
      return { assistantMessageId: existingId, created: false };
    }
    if (run.status !== "running") return null;

    const persisted = await tx
      .insert(chatMessages)
      .values({
        threadId,
        role: "assistant",
        content,
        modelId,
        runtime,
        tokensIn,
        tokensOut,
        toolCalls,
        toolResults,
      })
      .returning({ id: chatMessages.id });
    const assistantMessageId = persisted[0]!.id;
    const now = new Date();

    await tx
      .update(runs)
      .set({
        outputs: { ...currentOutputs, assistantMessageId },
        updatedAt: now,
      })
      .where(eq(runs.id, runId));
    await tx.insert(auditLog).values({
      actorUserId: userId,
      actionType: "chat_message_create",
      status: "succeeded",
      provider: "ai-hub",
      toolName: "chat_message_create",
      chatThreadId: threadId,
      chatMessageId: assistantMessageId,
      runId,
      input: { role: "assistant", lane },
      metadata: { modelId, runtime },
      startedAt: now,
      completedAt: now,
    });

    return { assistantMessageId, created: true };
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
