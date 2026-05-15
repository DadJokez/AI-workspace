import { eq } from "drizzle-orm";
import type { Database } from "./client";
import { chatThreads } from "./schema";

export interface UpdateThreadSummaryInput {
  threadId: string;
  summary: string | null;
  summaryUpdatedAt?: Date;
}

/**
 * Persist the rolling context summary for a chat thread.
 *
 * This intentionally does not touch `updated_at`: updating summarization
 * metadata should not make an old conversation look newly active in history.
 */
export async function updateThreadSummary(
  db: Database,
  { threadId, summary, summaryUpdatedAt = new Date() }: UpdateThreadSummaryInput,
) {
  const rows = await db
    .update(chatThreads)
    .set({
      summary,
      summaryUpdatedAt: summary === null ? null : summaryUpdatedAt,
    })
    .where(eq(chatThreads.id, threadId))
    .returning({
      id: chatThreads.id,
      summary: chatThreads.summary,
      summaryUpdatedAt: chatThreads.summaryUpdatedAt,
    });

  return rows[0] ?? null;
}
