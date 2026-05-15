import { type Database, chatThreads } from "@ai-workspace/db";
import { eq } from "drizzle-orm";

import type { ThreadAgentRecord, ThreadAgentStore } from "./cursor-runtime";

/**
 * `ThreadAgentStore` backed by `chat_threads.cursor_agent_id` (+
 * `chat_threads.mcp_signature`). While fresh-agent-per-turn is active, this
 * is a visibility/debug record for the latest Cursor agent created for a
 * thread. It is not the source of conversation continuity.
 */
export class DbThreadAgentStore implements ThreadAgentStore {
  constructor(private readonly db: Database) {}

  async get(threadId: string): Promise<ThreadAgentRecord | null> {
    const rows = await this.db
      .select({
        cursorAgentId: chatThreads.cursorAgentId,
        mcpSignature: chatThreads.mcpSignature,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId))
      .limit(1);
    const row = rows[0];
    if (!row?.cursorAgentId) return null;
    return {
      agentId: row.cursorAgentId,
      mcpSignature: row.mcpSignature ?? null,
    };
  }

  async set(threadId: string, record: ThreadAgentRecord): Promise<void> {
    await this.db
      .update(chatThreads)
      .set({
        cursorAgentId: record.agentId,
        mcpSignature: record.mcpSignature,
      })
      .where(eq(chatThreads.id, threadId));
  }

  async clear(threadId: string): Promise<void> {
    await this.db
      .update(chatThreads)
      .set({ cursorAgentId: null, mcpSignature: null })
      .where(eq(chatThreads.id, threadId));
  }
}
