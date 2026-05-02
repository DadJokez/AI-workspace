import { type Database, chatThreads } from "@ai-workspace/db";
import { eq } from "drizzle-orm";

import type { ThreadAgentStore } from "./cursor-runtime";

/**
 * `ThreadAgentStore` backed by `chat_threads.cursor_agent_id`. Lets a Cursor
 * agent survive process restarts: the next turn resumes the same `agentId`
 * instead of creating a fresh one and losing conversation state.
 */
export class DbThreadAgentStore implements ThreadAgentStore {
  constructor(private readonly db: Database) {}

  async get(threadId: string): Promise<string | null> {
    const rows = await this.db
      .select({ cursorAgentId: chatThreads.cursorAgentId })
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId))
      .limit(1);
    return rows[0]?.cursorAgentId ?? null;
  }

  async set(threadId: string, agentId: string): Promise<void> {
    await this.db
      .update(chatThreads)
      .set({ cursorAgentId: agentId })
      .where(eq(chatThreads.id, threadId));
  }
}
