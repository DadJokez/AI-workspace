import {
  chatMessages,
  chatThreads,
  type Database,
  recipeRuns,
} from "@ai-workspace/db";
import { getCursorCloudRunSnapshot } from "@ai-workspace/cursor-runtime";
import { and, desc, eq } from "drizzle-orm";

const MIN_RECOVERY_AGE_MS = 130_000;
const RECOVERY_POLL_INTERVAL_MS = 15_000;

interface StoredChatRunOutput {
  providerRun?: {
    runtime?: string;
    providerAgentId?: string;
    providerRunId?: string;
    executionMode?: string;
  };
  assistantMessageId?: string;
  providerRunLastCheckedAt?: string;
  [key: string]: unknown;
}

/**
 * Best-effort recovery for cloud-backed chat runs that outlived the HTTP
 * stream. It is called when a thread is reopened; terminal Cursor Cloud runs
 * are folded back into `chat_messages` so the user sees the answer in history.
 */
export async function reconcileThreadChatRuns({
  db,
  threadId,
}: {
  db: Database;
  threadId: string;
}): Promise<void> {
  if (!process.env.CURSOR_API_KEY) return;

  const rows = await db
    .select({
      id: recipeRuns.id,
      outputs: recipeRuns.outputs,
      modelId: recipeRuns.modelId,
      runtime: recipeRuns.runtime,
      startedAt: recipeRuns.startedAt,
      updatedAt: recipeRuns.updatedAt,
    })
    .from(recipeRuns)
    .where(
      and(
        eq(recipeRuns.threadId, threadId),
        eq(recipeRuns.recipeSlug, "chat-turn"),
        eq(recipeRuns.status, "running"),
      ),
    )
    .orderBy(desc(recipeRuns.updatedAt))
    .limit(5);

  for (const row of rows) {
    const runStartedAt = row.startedAt ?? row.updatedAt;
    const ageMs = Date.now() - runStartedAt.getTime();
    if (ageMs < MIN_RECOVERY_AGE_MS) continue;

    const output = parseOutput(row.outputs);
    if (wasRecentlyChecked(output.providerRunLastCheckedAt)) continue;

    const providerRun = output.providerRun;
    if (
      !providerRun ||
      providerRun.executionMode !== "cloud" ||
      !providerRun.providerAgentId ||
      !providerRun.providerRunId
    ) {
      continue;
    }

    try {
      const snapshot = await getCursorCloudRunSnapshot({
        apiKey: process.env.CURSOR_API_KEY,
        providerAgentId: providerRun.providerAgentId,
        providerRunId: providerRun.providerRunId,
      });

      if (snapshot.status === "running") {
        await db
          .update(recipeRuns)
          .set({
            outputs: {
              ...output,
              providerRun,
              providerRunSnapshot: snapshot,
              providerRunLastCheckedAt: new Date().toISOString(),
            },
            updatedAt: new Date(),
          })
          .where(eq(recipeRuns.id, row.id));
        continue;
      }

      const terminalStatus =
        snapshot.status === "finished"
          ? "succeeded"
          : snapshot.status === "cancelled"
            ? "canceled"
            : "failed";
      const completedAt = new Date();
      let assistantMessageId = output.assistantMessageId;
      const assistantText = snapshot.result?.trim();

      if (
        terminalStatus === "succeeded" &&
        assistantText &&
        !assistantMessageId
      ) {
        const inserted = await db
          .insert(chatMessages)
          .values({
            threadId,
            role: "assistant",
            content: assistantText,
            modelId: snapshot.modelId ?? row.modelId,
            runtime: row.runtime ?? "cursor",
            toolCalls: [],
            toolResults: [],
          })
          .returning({ id: chatMessages.id });
        assistantMessageId = inserted[0]!.id;
        await db
          .update(chatThreads)
          .set({ updatedAt: completedAt })
          .where(eq(chatThreads.id, threadId));
      }

      await db
        .update(recipeRuns)
        .set({
          status: terminalStatus,
          error:
            terminalStatus === "failed"
              ? "Cursor Cloud run ended with an error."
              : null,
          outputs: {
            ...output,
            providerRun,
            providerRunSnapshot: snapshot,
            providerRunLastCheckedAt: completedAt.toISOString(),
            ...(assistantText ? { assistantText } : {}),
            ...(assistantMessageId ? { assistantMessageId } : {}),
            recoveredFromProvider: true,
          },
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(recipeRuns.id, row.id));
    } catch (err) {
      process.stderr.write(
        `[chat-run-reconcile-error] ${JSON.stringify({
          runId: row.id,
          threadId,
          message: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
    }
  }
}

function parseOutput(value: unknown): StoredChatRunOutput {
  return isRecord(value) ? (value as StoredChatRunOutput) : {};
}

function wasRecentlyChecked(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const checkedAt = Date.parse(value);
  if (!Number.isFinite(checkedAt)) return false;
  return Date.now() - checkedAt < RECOVERY_POLL_INTERVAL_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
